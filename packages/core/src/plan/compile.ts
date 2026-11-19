import { join } from "node:path";
import { loadCatalogOverlay } from "../catalog/pack.js";
import type { Pack } from "../catalog/pack.js";
import { catalogRoot } from "../catalog/locate.js";
import { fingerprint } from "../fingerprint.js";
import type { Fingerprint } from "../fingerprint.js";
import { readText } from "../util/fs.js";
import { resolvePacks } from "../resolve/resolve.js";
import { emitAgentsMd } from "../emit/agentsMd.js";
import { emitDevin, permUnion } from "../emit/devin.js";
import { emitClaude } from "../emit/claude.js";
import { emitCursor } from "../emit/cursor.js";
import { emitWindsurf } from "../emit/windsurf.js";
import { emitCopilot } from "../emit/copilot.js";
import { emitCi } from "../emit/ci.js";
import { emitKeelDir } from "../emit/keelDir.js";
import { readLockfile } from "./lockfile.js";
import { restoredContent } from "./restore.js";
import type { EmitInput } from "../emit/context.js";
import type { DesiredFile } from "../emit/context.js";
import type { HarnessSpec } from "../spec/schema.js";
import type { FileOp, HarnessPlan } from "./types.js";

export interface CompileOptions {
  catalog?: Map<string, Pack>;
  catalog_root?: string;
  fp?: Fingerprint | null;
}

/** spec + repo + catalog → deterministic file plan. Pure computation over inputs; writes nothing. */
export function compilePlan(dir: string, spec: HarnessSpec, opts: CompileOptions = {}): HarnessPlan {
  const fp = opts.fp !== undefined ? opts.fp : fingerprint(dir);
  const warnings: string[] = [];
  const errors: string[] = [];

  let catalog = opts.catalog;
  if (!catalog) {
    const roots = [opts.catalog_root ?? catalogRoot(), ...spec.packs.dirs.map((d) => join(dir, d))];
    const overlay = loadCatalogOverlay(roots);
    catalog = overlay.packs;
    for (const id of overlay.overridden)
      warnings.push(`${id}: overridden by a pack from packs.dirs — local catalog wins`);
  }
  const resolution = resolvePacks(spec, fp, catalog);

  const input: EmitInput = {
    spec,
    fp,
    packs: resolution.selected,
    dir,
    read: (rel) => readText(join(dir, rel)),
  };

  const desired: DesiredFile[] = [];

  const agents = emitAgentsMd(input, "AGENTS.md");
  desired.push(agents.file);
  if (spec.targets.includes("claude")) desired.push(emitAgentsMd(input, "CLAUDE.md").file);

  if (spec.targets.includes("devin")) {
    const devin = emitDevin(input);
    desired.push(...devin.files);
    errors.push(...devin.errors);
  }
  if (spec.targets.includes("claude")) {
    const claude = emitClaude(input, permUnion(resolution.selected, spec));
    desired.push(...claude.files);
    warnings.push(...claude.warnings);
    errors.push(...claude.errors);
  }
  if (spec.targets.includes("cursor")) {
    const r = emitCursor(input);
    desired.push(...r.files);
    warnings.push(...r.warnings);
    errors.push(...r.errors);
  }
  if (spec.targets.includes("windsurf")) {
    const r = emitWindsurf(input);
    desired.push(...r.files);
    warnings.push(...r.warnings);
    errors.push(...r.errors);
  }
  if (spec.targets.includes("copilot")) {
    const r = emitCopilot(input);
    desired.push(...r.files);
    warnings.push(...r.warnings);
    errors.push(...r.errors);
  }
  if (spec.targets.includes("codex"))
    warnings.push("codex reads AGENTS.md natively — no additional files emitted");

  const ci = emitCi(input);
  desired.push(...ci.files);
  warnings.push(...ci.warnings);

  const keel = emitKeelDir(input);
  desired.push(...keel.files);
  warnings.push(...keel.warnings);

  // Budget enforcement
  if (agents.tokens > spec.budget.always_on_tokens)
    errors.push(
      `managed block is ~${agents.tokens} tokens, over the ${spec.budget.always_on_tokens} budget — cut packs or raise budget.always_on_tokens`,
    );
  const skillCount = resolution.selected.filter((p) => p.emits.skill).length;
  if (skillCount > spec.budget.max_skills)
    errors.push(`${skillCount} skills selected exceeds budget.max_skills=${spec.budget.max_skills}`);

  // Stale managed files (in lockfile, not desired anymore).
  // created=true → delete; created=false → inverse-merge restores user content (never deletes).
  const lock = readLockfile(dir);
  const desiredPaths = new Set(desired.map((f) => f.path));
  const staleOps: FileOp[] = [];
  if (lock) {
    for (const entry of lock.files) {
      if (desiredPaths.has(entry.path) || entry.path === "keel.lock.json") continue;
      if (entry.created) {
        staleOps.push({ path: entry.path, content: null, origin: "stale", action: "delete" });
        continue;
      }
      const text = input.read(entry.path);
      if (text === null) continue;
      const restore = restoredContent(entry, text);
      if (restore.action === "delete") {
        staleOps.push({ path: entry.path, content: null, origin: "stale-restore", action: "delete", no_lock: true });
      } else if (restore.action === "rewrite" && restore.content !== text) {
        staleOps.push({ path: entry.path, content: restore.content ?? null, origin: "stale-restore", action: "modify", no_lock: true });
      }
      // "keep" or identical content → no op; file simply leaves management
    }
  }

  const ops: FileOp[] = desired.map((f) => {
    const existing = input.read(f.path);
    const action: FileOp["action"] = existing === null ? "create" : existing === f.content ? "unchanged" : "modify";
    return {
      path: f.path,
      content: f.content,
      origin: f.origin,
      action,
      ...(f.managed_block ? { managed_block: true } : {}),
      ...(f.undo ? { undo: f.undo } : {}),
    };
  });
  ops.push(...staleOps);

  // Honest enforcement coverage: "enforced" is only credited when the pack's own
  // emitted mechanism is mechanical — permissions/hooks, the boundary gate for the
  // declared architecture pack, or the Stop hook for verified-completion.
  const hasBoundaries = spec.architecture.layers.length > 0;
  const boundaryPack = `architecture/${spec.architecture.style}`;
  const enforcedBacked = (p: Pack): boolean => {
    const perms = p.emits.permissions;
    if (perms.allow.length + perms.ask.length + perms.deny.length > 0) return true;
    if (p.slot === "architecture" && p.id === boundaryPack && hasBoundaries) return true;
    if (p.id === "workflow/verified-completion" && spec.autonomy.stop_hook && spec.autonomy.mode !== "guided")
      return true;
    return false;
  };
  const checkedBacked = (p: Pack): boolean => p.emits.checks.length > 0;
  const coverage = { enforced: 0, checked: 0, advised: 0 };
  for (const p of resolution.selected) {
    let level = p.enforcement;
    if (level === "enforced" && !enforcedBacked(p)) level = checkedBacked(p) ? "checked" : "advised";
    if (level === "checked" && !checkedBacked(p)) level = "advised";
    coverage[level]++;
    if (level !== p.enforcement)
      warnings.push(`${p.id}: claims ${p.enforcement} without mechanical backing here — counted as ${level}`);
  }
  if (hasBoundaries) coverage.enforced++; // the boundary checker itself
  if (spec.style.max_nesting > 0 || spec.style.max_function_lines > 0) coverage.checked++; // check-style.mjs
  if (spec.autonomy.verify || (fp?.scripts ?? []).some((s) => ["verify", "typecheck", "lint", "test"].includes(s)))
    coverage.checked++;

  return {
    ops,
    bySlot: resolution.bySlot,
    selected: resolution.selected,
    rejected: resolution.rejected,
    conflicts: resolution.conflicts,
    warnings,
    errors,
    always_on_tokens: agents.tokens,
    always_on_budget: spec.budget.always_on_tokens,
    coverage,
  };
}
