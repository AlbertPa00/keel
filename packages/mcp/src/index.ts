#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { stringify } from "yaml";
import {
  apply,
  boundaryViolations,
  catalogRoot,
  check,
  compilePlan,
  doctor,
  draftSpec,
  fingerprint,
  importGraph,
  loadCatalog,
  loadSpec,
  loadTaste,
  mergeTaste,
  parseSpec,
  remove,
  searchCatalog,
  specPath,
  specToYaml,
  tastePath,
  tasteSchema,
  upsertExceptionsYaml,
  violationsToExceptions,
} from "@keel/core";
import type { HarnessPlan, Slot } from "@keel/core";

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : stringify(data) }],
});
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true as const });

function specFor(path: string, specYaml?: string) {
  if (specYaml) return parseSpec(specYaml);
  return loadSpec(path).spec;
}

function planView(plan: HarnessPlan) {
  return {
    selected: plan.selected.map((p) => ({ id: p.id, enforcement: p.enforcement, token_cost: p.token_cost })),
    rejected: plan.rejected,
    conflicts: plan.conflicts,
    coverage: plan.coverage,
    always_on_tokens: plan.always_on_tokens,
    always_on_budget: plan.always_on_budget,
    warnings: plan.warnings,
    errors: plan.errors,
    ops: plan.ops.map((o) => ({ path: o.path, action: o.action, origin: o.origin })),
  };
}

const server = new McpServer({ name: "keel", version: "0.1.0" });

server.registerTool(
  "keel_fingerprint",
  {
    description: "Detect a workspace's stack, package manager, frameworks, test runner, and existing agent config dirs. Read-only.",
    inputSchema: { path: z.string().describe("absolute workspace path") },
  },
  ({ path }) => {
    try {
      return text(fingerprint(resolve(path)));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_draft_spec",
  {
    description:
      "Draft a harness.yaml for a workspace: detected values are marked, unresolved fields are returned as questions instead of guesses. Returns YAML to review — writes nothing.",
    inputSchema: {
      path: z.string().describe("absolute workspace path"),
      intent: z.string().optional().describe("free-text design intent (architecture, style, constraints)"),
    },
  },
  ({ path, intent }) => {
    try {
      const draft = draftSpec(fingerprint(resolve(path)), intent ?? "");
      // Taste seeds the draft only; plan/apply/check stay machine-deterministic.
      const seeded = mergeTaste(draft.spec, loadTaste());
      return text({
        harness_yaml: specToYaml(seeded),
        detected: draft.fields,
        conflicts: draft.conflicts,
        questions: draft.questions,
      });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_search",
  {
    description:
      "Search the curated pack catalog by intent query. Returns grouped candidates with enforcement level (enforced|checked|advised) and token cost.",
    inputSchema: {
      query: z.string(),
      slot: z.enum(["stack", "architecture", "style", "safety", "workflow"]).optional(),
    },
  },
  ({ query, slot }) => {
    try {
      const hits = searchCatalog(loadCatalog(catalogRoot()), query, slot as Slot | undefined);
      return text(
        hits.map((h) => ({
          id: h.pack.id,
          name: h.pack.name,
          enforcement: h.pack.enforcement,
          token_cost: h.pack.token_cost,
          score: Number(h.score.toFixed(2)),
          matched: h.matched,
        })),
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_plan",
  {
    description:
      "Compute the harness plan for a workspace (files, pack selection, enforcement coverage, token budget). Dry-run by definition — never writes.",
    inputSchema: {
      path: z.string().describe("absolute workspace path"),
      spec_yaml: z.string().optional().describe("harness.yaml content; if omitted, read from <path>/harness.yaml"),
    },
  },
  ({ path, spec_yaml }) => {
    try {
      const spec = specFor(resolve(path), spec_yaml);
      return text(planView(compilePlan(resolve(path), spec)));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_apply",
  {
    description:
      "Write the harness into the workspace (managed blocks, permissions, hooks, skills, .keel scripts) + keel.lock.json. Refuses on plan errors. Use dry_run=true to preview.",
    inputSchema: {
      path: z.string(),
      spec_yaml: z.string().optional(),
      dry_run: z.boolean().default(true),
    },
  },
  ({ path, spec_yaml, dry_run }) => {
    try {
      const dir = resolve(path);
      const spec = specFor(dir, spec_yaml);
      if (dry_run) return text({ dry_run: true, ...planView(compilePlan(dir, spec)) });
      const res = apply(dir, spec);
      return text({ applied: res.applied, written: res.written, deleted: res.deleted, unchanged: res.unchanged, errors: res.plan.errors });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_check",
  {
    description: "Drift check — compare the on-disk harness against the compiled plan. Returns modified/missing/stale files.",
    inputSchema: { path: z.string() },
  },
  ({ path }) => {
    try {
      const dir = resolve(path);
      const spec = specFor(dir);
      const res = check(dir, spec);
      return text({ ok: res.ok, modified: res.modified, missing: res.missing, stale: res.stale, errors: res.plan.errors });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_remove",
  {
    description:
      "Uninstall the harness — strips managed blocks, inverse-merges permissions/hooks, deletes created files and the lockfile. Never touches user content outside managed blocks.",
    inputSchema: { path: z.string() },
  },
  ({ path }) => {
    try {
      const res = remove(resolve(path));
      return text({ removed: res.removed, restored: res.restored, skipped: res.skipped });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_graph",
  {
    description:
      "Report the repo's real module-level import graph (aggregated by source dirs, monorepo-aware). Read-only — use before declaring architecture.layers.",
    inputSchema: { path: z.string().describe("absolute workspace path") },
  },
  ({ path }) => {
    try {
      const edges = importGraph(resolve(path));
      const counts = new Map<string, number>();
      for (const e of edges) {
        if (!e.to) continue;
        const a = e.from.split("/").slice(0, 3).join("/");
        const b = e.to.split("/").slice(0, 3).join("/");
        if (a === b) continue;
        const k = `${a} -> ${b}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const rows = [...counts.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
      return text(rows.slice(0, 80).map(([edge, count]) => ({ edge, count })));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_ratchet",
  {
    description:
      "Record current boundary violations as shrink-only architecture.exceptions in harness.yaml (writes the spec file). Run keel_apply afterwards.",
    inputSchema: { path: z.string(), dry_run: z.boolean().default(true) },
  },
  ({ path, dry_run }) => {
    try {
      const dir = resolve(path);
      const sp = specPath(dir);
      const spec = loadSpec(dir).spec;
      if (!spec.architecture.layers.length) return fail("no architecture.layers declared — nothing to ratchet against");
      const violations = boundaryViolations(dir, spec.architecture.layers, spec.architecture.exceptions);
      if (!violations.length) return text({ violations: 0, note: "no boundary violations — layers already match the code" });
      const entries = violationsToExceptions(violations, spec.architecture.exceptions);
      if (!dry_run) writeFileSync(sp, upsertExceptionsYaml(readFileSync(sp, "utf8"), entries), "utf8");
      return text({ dry_run, violations, exceptions: entries, wrote: dry_run ? null : sp });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_doctor",
  {
    description:
      "Environment + harness health check: node engines, package manager on PATH, installed deps, spec drift, verify gate presence. Read-only.",
    inputSchema: { path: z.string().describe("absolute workspace path") },
  },
  ({ path }) => {
    try {
      return text(doctor(resolve(path)));
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

server.registerTool(
  "keel_taste",
  {
    description:
      "Read the user's global taste profile (paradigm, principles, budgets). Pass profile_json to overwrite — project spec always wins over taste.",
    inputSchema: { profile_json: z.string().optional().describe("JSON taste profile to persist") },
  },
  ({ profile_json }) => {
    try {
      if (!profile_json) return text({ path: tastePath(), profile: loadTaste() });
      const parsed = tasteSchema.safeParse(JSON.parse(profile_json));
      if (!parsed.success)
        return fail(`invalid taste profile:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
      mkdirSync(dirname(tastePath()), { recursive: true });
      writeFileSync(tastePath(), `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
      return text({ written: tastePath(), profile: parsed.data });
    } catch (e) {
      return fail((e as Error).message);
    }
  },
);

await server.connect(new StdioServerTransport());
