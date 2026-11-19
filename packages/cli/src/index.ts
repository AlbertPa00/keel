#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  apply,
  boundaryViolations,
  catalogRoot,
  check,
  compilePlan,
  discoverArchitecture,
  doctor,
  draftSpec,
  fingerprint,
  importGraph,
  loadCatalog,
  loadSpec as coreLoadSpec,
  loadSpecFile,
  loadTaste,
  mergeTaste,
  outdated,
  remove,
  searchCatalog,
  specPath,
  specToYaml,
  staleExceptions,
  tastePath,
  tasteSchema,
  upsertExceptionsYaml,
  violationsToExceptions,
} from "@keel/core";
import type { HarnessPlan, Slot } from "@keel/core";
import { stringify } from "yaml";

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const err = (s: string): void => {
  process.stderr.write(`${s}\n`);
};
const die = (s: string): never => {
  err(`keel: ${s}`);
  process.exit(1);
};

type ParseOpts = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;
type ValuesFor<O extends ParseOpts> = {
  [K in keyof O]?: O[K] extends { type: "string"; multiple: true }
    ? string[]
    : O[K] extends { type: "string" }
      ? string
      : O[K] extends { type: "boolean"; multiple: true }
        ? boolean[]
        : O[K] extends { type: "boolean" }
          ? boolean
          : never;
};
function args<const O extends ParseOpts>(argv: string[], options: O): { values: ValuesFor<O>; positionals: string[] } {
  try {
    const res = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
    return res as unknown as { values: ValuesFor<O>; positionals: string[] };
  } catch (e) {
    return die((e as Error).message);
  }
}

function loadSpec(dir: string, specFlag?: string) {
  if (specFlag) return loadSpecFile(specFlag);
  try {
    return coreLoadSpec(dir).spec;
  } catch (e) {
    return die((e as Error).message);
  }
}

function safeTaste() {
  try {
    return loadTaste();
  } catch {
    return {};
  }
}

const USAGE = `keel — deterministic agent-harness compiler

  keel init [dir]                 write a draft harness.yaml from repo detection
                                  --discover  auto-synthesize layers + ratchet from the import graph
  keel fingerprint [dir]          print detected repo signals
  keel graph [dir]                report the module-level import graph
  keel ratchet [dir]              record current boundary violations as exceptions
  keel search <query> [--slot s]  search the pack catalog
  keel packs [list|show <id>]     inspect catalog packs
  keel plan [dir]                 show what would be written (no changes)
  keel apply [dir]                write the harness + keel.lock.json
  keel check [dir]                drift check (exit 1 on drift)
  keel outdated [dir]             which selected packs changed since last apply
  keel remove [dir]               uninstall the harness (inverse-merge)
  keel doctor [dir]               environment + harness health check
  keel taste [--set k=v ...]      view/edit global taste profile

Options: --spec <path>  --dir <path>  --slot <slot>  --force  --json`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help") return out(USAGE);

  const shared = {
    spec: { type: "string" as const },
    dir: { type: "string" as const },
    json: { type: "boolean" as const },
  };

  switch (cmd) {
    case "fingerprint": {
      const { values, positionals } = args(rest, shared);
      const dir = resolve(values.dir ?? positionals[0] ?? ".");
      out(JSON.stringify(fingerprint(dir), null, 2));
      return;
    }

    case "init": {
      const { values, positionals } = args(rest, { ...shared, force: { type: "boolean" }, intent: { type: "string" }, discover: { type: "boolean" } });
      const dir = resolve(values.dir ?? positionals[0] ?? ".");
      const target = resolve(dir, "harness.yaml");
      if (existsSync(target) && !values.force) die("harness.yaml exists — pass --force to overwrite");
      // Taste seeds the draft only — plan/apply/check never re-merge it, so
      // committed harnesses stay byte-deterministic across machines.
      const draft = draftSpec(fingerprint(dir), values.intent ?? "");
      const seeded = mergeTaste(draft.spec, safeTaste());
      const notes: string[] = [];
      if (values.discover) {
        const found = discoverArchitecture(dir);
        seeded.architecture.layers = found.layers;
        seeded.architecture.exceptions = found.exceptions;
        if (found.layers.length) seeded.architecture.style = "layered";
        notes.push(...found.notes);
      }
      writeFileSync(target, specToYaml(seeded), "utf8");
      out(`wrote ${target}`);
      for (const c of draft.conflicts) out(`  ! conflict: ${c}`);
      for (const n of notes) out(`  ~ discover: ${n}`);
      for (const q of draft.questions) out(`  ? ${q}`);
      return;
    }

    case "search": {
      const { values, positionals } = args(rest, { ...shared, slot: { type: "string" } });
      const query = positionals.join(" ");
      if (!query) die("search needs a query");
      const catalog = loadCatalog(catalogRoot());
      const hits = searchCatalog(catalog, query, values.slot as Slot | undefined);
      if (values.json) return out(JSON.stringify(hits.map((h) => ({ id: h.pack.id, score: h.score, matched: h.matched })), null, 2));
      for (const h of hits.slice(0, 15))
        out(`${h.score.toFixed(1)}  ${h.pack.id}  ${h.pack.name}  [${h.pack.enforcement}] ${h.matched.join(",")}`);
      if (hits.length === 0) out("no packs matched");
      return;
    }

    case "packs": {
      const { positionals } = args(rest, shared);
      const catalog = loadCatalog(catalogRoot());
      if (positionals[0] === "show") {
        const p = catalog.get(positionals[1] ?? "");
        if (!p) die(`unknown pack ${positionals[1]}`);
        return out(stringify({ ...p, dir: undefined }));
      }
      for (const p of [...catalog.values()].sort((a, b) => a.id.localeCompare(b.id)))
        out(`${p.id.padEnd(36)} ${p.slot.padEnd(13)} ${p.enforcement.padEnd(9)} ${p.name}`);
      return;
    }

    case "graph": {
      const { values, positionals } = args(rest, shared);
      const dir = resolve(values.dir ?? positionals[0] ?? ".");
      const edges = importGraph(dir);
      const counts = new Map<string, number>();
      for (const e of edges) {
        if (!e.to) continue;
        const srcNode = moduleOf(e.from);
        const dstNode = moduleOf(e.to);
        if (srcNode === dstNode) continue;
        const key = `${srcNode} -> ${dstNode}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const rows = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      if (values.json) return out(JSON.stringify(rows.map(([edge, count]) => ({ edge, count })), null, 2));
      for (const [edge, count] of rows.slice(0, 60)) out(`${String(count).padStart(4)}  ${edge}`);
      if (rows.length > 60) out(`… +${rows.length - 60} more edges`);
      return;
    }

    case "ratchet": {
      const { values, positionals } = args(rest, shared);
      const dir = resolve(values.dir ?? positionals[0] ?? ".");
      const sp = specPath(dir);
      if (!existsSync(sp)) die(`no harness.yaml in ${dir} — run \`keel init\` first`);
      const spec = loadSpecFile(sp);
      if (!spec.architecture.layers.length) die("no architecture.layers declared — ratchet needs declared layers");
      const violations = boundaryViolations(dir, spec.architecture.layers, spec.architecture.exceptions);
      if (!violations.length) {
        const stale = staleExceptions(dir, spec.architecture.layers, spec.architecture.exceptions);
        out("no boundary violations — layers already match the code");
        for (const e of stale) out(`  ! stale ratchet entry (remove it): ${e.file} allow [${e.allow.join(",")}]`);
        return;
      }
      const entries = violationsToExceptions(violations, spec.architecture.exceptions);
      const text = readFileSync(sp, "utf8");
      writeFileSync(sp, upsertExceptionsYaml(text, entries), "utf8");
      out(`ratcheted ${violations.length} violation(s) into ${sp}:`);
      for (const v of violations) out(`  ${v.file}:${v.line}  [${v.from_layer}] -> [${v.to_layer}]`);
      out(`\nrun \`keel plan\` to review, then \`keel apply\` — shrink exceptions as files get fixed, never grow them`);
      return;
    }

    case "plan":
    case "apply":
    case "check":
    case "outdated":
    case "remove": {
      const { values, positionals } = args(rest, shared);
      const dir = resolve(values.dir ?? positionals[0] ?? ".");
      if (cmd === "remove") {
        const res = remove(dir);
        out(`removed ${res.removed.length} file(s), restored ${res.restored.length} file(s)`);
        for (const s of res.skipped) out(`  skipped (drifted): ${s}`);
        return;
      }
      const spec = loadSpec(dir, values.spec);

      if (cmd === "apply") {
        const res = apply(dir, spec);
        printPlan(res.plan);
        if (!res.applied) die("plan has errors — nothing written");
        out(`\napplied: ${res.written.length} written, ${res.deleted.length} deleted, ${res.unchanged} unchanged`);
        return;
      }
      if (cmd === "check") {
        const res = check(dir, spec);
        if (res.ok) return out("ok: no drift");
        for (const m of res.modified) out(`  modified: ${m}`);
        for (const m of res.missing) out(`  missing:  ${m}`);
        for (const s of res.stale) out(`  stale:    ${s}`);
        process.exit(1);
      }
      if (cmd === "outdated") {
        const res = outdated(dir, spec);
        if (res.lock_missing) return out("no keel.lock.json — run keel apply first");
        if (res.entries.length === 0) return out("ok: all selected packs match the lockfile");
        for (const e of res.entries) out(`  ${e.kind.padEnd(8)} ${e.id}  ${e.locked} → ${e.current}`);
        return;
      }
      // plan
      const plan = compilePlan(dir, spec);
      printPlan(plan);
      if (values.json) out(JSON.stringify(plan.ops.map((o) => ({ path: o.path, action: o.action, origin: o.origin })), null, 2));
      return;
    }

    case "doctor": {
      const { values, positionals } = args(rest, shared);
      const dir = resolve(values.dir ?? positionals[0] ?? ".");
      const report = doctor(dir);
      if (values.json) return out(JSON.stringify(report, null, 2));
      for (const c of report.checks) {
        const icon = c.status === "pass" ? "ok" : c.status.toUpperCase();
        out(`${icon.padEnd(5)} ${c.name.padEnd(17)} ${c.detail}${c.fix ? `  → ${c.fix}` : ""}`);
      }
      if (!report.ok) process.exit(1);
      return;
    }

    case "taste": {
      const { values } = args(rest, { set: { type: "string", multiple: true } });
      const p = tastePath();
      if (!values.set?.length) {
        out(existsSync(p) ? `${p}\n${stringify(loadTaste())}` : `no taste profile (would live at ${p})`);
        return;
      }
      const taste = loadTaste() as Record<string, unknown>;
      for (const kv of values.set) {
        const eq = kv.indexOf("=");
        if (eq <= 0) die(`bad --set ${kv} (want key=value)`);
        const k = kv.slice(0, eq);
        const v = kv.slice(eq + 1);
        taste[k] = /^\d+$/.test(v) ? Number(v) : v;
      }
      const parsed = tasteSchema.safeParse(taste);
      if (!parsed.success) die(`invalid taste profile:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
      out(`wrote ${p}`);
      return;
    }

    default:
      die(`unknown command ${cmd}\n\n${USAGE}`);
  }
}

/** Bucket a repo-relative path into a coarse module node for `keel graph`. */
function moduleOf(rel: string): string {
  const ws = /^(apps|packages|libs|services|src)\/([^/]+)\/src\/(.+)$/.exec(rel);
  if (ws) {
    const seg = ws[3]!.split("/")[0]!;
    return `${ws[2]}:${seg.includes(".") ? "·" : seg}`;
  }
  const root = /^src\/(.+)$/.exec(rel);
  if (root) {
    const seg = root[1]!.split("/")[0]!;
    return `src:${seg.includes(".") ? "·" : seg}`;
  }
  const first = rel.split("/")[0]!;
  return first.includes(".") ? "(root)" : first;
}

function printPlan(plan: HarnessPlan): void {
  out(`selected packs (${plan.selected.length}):`);
  for (const p of plan.selected) out(`  ${p.id.padEnd(36)} [${p.enforcement}]`);
  if (plan.rejected.length) {
    out("rejected:");
    for (const r of plan.rejected.slice(0, 12)) out(`  ${r.pack} — ${r.reason}`);
  }
  out(`\ncoverage: ${plan.coverage.enforced} enforced · ${plan.coverage.checked} checked · ${plan.coverage.advised} advised`);
  out(`always-on: ~${plan.always_on_tokens} tokens (budget ${plan.always_on_budget})`);
  for (const w of plan.warnings) out(`warning: ${w}`);
  for (const e of plan.errors) out(`ERROR: ${e}`);
  out("\nfile ops:");
  for (const op of plan.ops) if (op.action !== "unchanged") out(`  ${op.action.padEnd(8)} ${op.path}  (${op.origin})`);
}

main().catch((e) => die((e as Error).message));
