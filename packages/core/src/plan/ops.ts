import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileSha, readJson, sha256 } from "../util/fs.js";
import { compilePlan } from "./compile.js";
import type { CompileOptions } from "./compile.js";
import { LOCKFILE_NAME, catalogHash, lockfileContent, specHash } from "./lockfile.js";
import { restoredContent } from "./restore.js";
import type { HarnessSpec } from "../spec/schema.js";
import type { HarnessPlan, LockFile, LockFileEntry, MergeUndo } from "./types.js";

export interface ApplyResult {
  plan: HarnessPlan;
  applied: boolean;
  written: string[];
  deleted: string[];
  unchanged: number;
}

/** Root dirs keel may create — pruned bottom-up when empty, user files are never touched. */
const MANAGED_ROOTS = [".keel", ".devin", ".claude", ".cursor", ".windsurf", ".codex", ".github/instructions"];

function writeOp(dir: string, path: string, content: string): void {
  const abs = join(dir, path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function mergeUndo(prev: MergeUndo | undefined, next: MergeUndo | undefined): MergeUndo | undefined {
  if (!prev) return next;
  if (!next) return prev;
  const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
  const out: MergeUndo = {
    hooks_existed: prev.hooks_existed ?? next.hooks_existed ?? false,
    permissions_existed: prev.permissions_existed ?? next.permissions_existed ?? false,
    rcf_existed: prev.rcf_existed ?? next.rcf_existed ?? false,
  };
  if (prev.rcf_claude_added || next.rcf_claude_added) out.rcf_claude_added = true;
  if (prev.permissions_added || next.permissions_added) {
    out.permissions_added = {
      allow: union(prev.permissions_added?.allow, next.permissions_added?.allow),
      ask: union(prev.permissions_added?.ask, next.permissions_added?.ask),
      deny: union(prev.permissions_added?.deny, next.permissions_added?.deny),
    };
  }
  if (prev.permissions_evicted || next.permissions_evicted) {
    out.permissions_evicted = {
      allow: union(prev.permissions_evicted?.allow, next.permissions_evicted?.allow),
      ask: union(prev.permissions_evicted?.ask, next.permissions_evicted?.ask),
    };
  }
  if (prev.hook_commands_added || next.hook_commands_added) {
    out.hook_commands_added = union(prev.hook_commands_added, next.hook_commands_added);
  }
  return out;
}

function readLockfile(dir: string): LockFile | null {
  return readJson<LockFile>(join(dir, LOCKFILE_NAME));
}

function readLockfileEntries(dir: string): LockFileEntry[] {
  return readLockfile(dir)?.files ?? [];
}

/** Write the plan to disk and record the lockfile. Refuses when plan.errors is non-empty. */
export function apply(dir: string, spec: HarnessSpec, opts: CompileOptions = {}): ApplyResult {
  const plan = compilePlan(dir, spec, opts);
  if (plan.errors.length) return { plan, applied: false, written: [], deleted: [], unchanged: 0 };

  const priorLock = readLockfile(dir);
  const prior = new Map((priorLock?.files ?? []).map((e) => [e.path, e]));
  const written: string[] = [];
  const deleted: string[] = [];
  let unchanged = 0;
  const lockEntries: LockFileEntry[] = [];

  for (const op of plan.ops) {
    const abs = join(dir, op.path);
    if (op.action === "delete") {
      if (existsSync(abs)) {
        rmSync(abs);
        deleted.push(op.path);
      }
      continue;
    }
    if (op.action !== "unchanged") {
      writeOp(dir, op.path, op.content!);
      written.push(op.path);
    } else unchanged++;
    // stale-restore ops leave management: they must not appear in the new lockfile
    if (op.no_lock) continue;
    const prev = prior.get(op.path);
    const created = prev?.created ?? op.action === "create";
    const undo = mergeUndo(prev?.undo, op.undo);
    lockEntries.push({
      path: op.path,
      sha256: sha256(op.content!),
      created,
      managed_block: op.managed_block ?? false,
      ...(undo ? { undo } : {}),
    });
  }

  // Deletes may leave empty dirs behind — prune empty managed roots only.
  if (deleted.length) pruneEmptyDirs(dir, MANAGED_ROOTS);

  // Lockfile stability: identical managed state → leave the existing file untouched (no git churn).
  const candidate = lockfileContent(plan.selected, spec, lockEntries);
  if (priorLock) {
    const prevStable = JSON.stringify({ ...priorLock, generated_at: "" });
    const nextStable = JSON.stringify({ ...(JSON.parse(candidate) as LockFile), generated_at: "" });
    if (prevStable !== nextStable) {
      writeOp(dir, LOCKFILE_NAME, candidate);
      written.push(LOCKFILE_NAME);
    }
  } else {
    writeOp(dir, LOCKFILE_NAME, candidate);
    written.push(LOCKFILE_NAME);
  }

  return { plan, applied: true, written, deleted, unchanged };
}

export interface CheckResult {
  ok: boolean;
  modified: string[];
  missing: string[];
  stale: string[];
  /** spec or catalog changed since last apply — re-apply required. */
  spec_stale: boolean;
  plan: HarnessPlan;
}

/** Drift check: desired state vs disk + lockfile freshness. Exits nonzero-equivalent via ok=false. */
export function check(dir: string, spec: HarnessSpec, opts: CompileOptions = {}): CheckResult {
  const plan = compilePlan(dir, spec, opts);
  const desired = new Set(plan.ops.filter((o) => !o.no_lock).map((o) => o.path));
  const modified: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];

  for (const op of plan.ops) {
    const abs = join(dir, op.path);
    if (op.action === "delete") continue;
    if (!existsSync(abs)) {
      missing.push(op.path);
      continue;
    }
    if (fileSha(abs) !== sha256(op.content!)) modified.push(op.path);
  }
  const lock = readLockfile(dir);
  let spec_stale = false;
  if (lock) {
    for (const entry of lock.files) {
      if (!desired.has(entry.path)) stale.push(entry.path);
    }
    if (lock.spec_hash !== specHash(spec) || lock.catalog_hash !== catalogHash(plan.selected)) spec_stale = true;
  } else if (plan.ops.some((o) => o.action !== "delete")) {
    // Managed files exist on disk but no lockfile → keel can't prove provenance.
    spec_stale = true;
  }
  const ok = modified.length + missing.length + stale.length + plan.errors.length === 0 && !spec_stale;
  return { ok, modified, missing, stale, spec_stale, plan };
}

export interface RemoveResult {
  removed: string[];
  restored: string[];
  skipped: string[];
}

/** Remove directories only when empty, bottom-up — never touches user files. */
function pruneEmptyDirs(dir: string, roots: string[]): void {
  const visit = (abs: string): boolean => {
    if (!existsSync(abs)) return true;
    let empty = true;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!visit(join(abs, e.name))) empty = false;
      } else empty = false;
    }
    if (empty) rmdirSync(abs);
    return empty;
  };
  for (const rel of roots) visit(join(dir, rel));
}

/** Inverse of apply: restore merged files, delete created ones, drop the lockfile. */
export function remove(dir: string): RemoveResult {
  const entries = readLockfileEntries(dir);
  const removed: string[] = [];
  const restored: string[] = [];
  const skipped: string[] = [];

  for (const e of entries) {
    const abs = join(dir, e.path);
    if (e.created) {
      if (existsSync(abs)) {
        rmSync(abs);
        removed.push(e.path);
      }
      continue;
    }
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (text === null) {
      skipped.push(e.path);
      continue;
    }
    const restore = restoredContent(e, text);
    if (restore.action === "delete") {
      rmSync(abs);
      removed.push(e.path);
    } else if (restore.action === "rewrite") {
      writeFileSync(abs, restore.content!, "utf8");
      restored.push(e.path);
    }
    // "keep" → file untouched
  }

  if (existsSync(join(dir, LOCKFILE_NAME))) {
    rmSync(join(dir, LOCKFILE_NAME));
    removed.push(LOCKFILE_NAME);
  }
  pruneEmptyDirs(dir, MANAGED_ROOTS);
  return { removed, restored, skipped };
}

