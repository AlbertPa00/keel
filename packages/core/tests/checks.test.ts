import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { catalogRoot, compilePlan, loadCatalog } from "../src/index.js";
import { loadCatalogOverlay } from "../src/catalog/pack.js";
import { parseSpec } from "../src/spec/load.js";
import { CHECK_PACKS } from "../src/emit/scripts.js";

/** Derive a probe path the check's first glob will match ("src/**\/*.ts" → "src/x.ts"). */
const probePath = (glob: string): string => {
  let p = glob.replace(/\*\*\//g, "");
  p = p.replace(/\/\*+$/, "/x.ts");
  p = p.replace(/\*/g, "x");
  if (p.endsWith(".x")) p = p.slice(0, -2) + ".ts";
  else if (!/\.[a-z]+$/.test(p)) p += ".ts";
  return p;
};

const runGate = (dir: string) =>
  spawnSync(process.execPath, [".keel/check-packs.mjs"], { cwd: dir, encoding: "utf8" });

describe("emits.checks — every checked pack ships trip/pass fixtures", () => {
  const catalog = loadCatalog(catalogRoot());
  const checked = [...catalog.values()].filter((p) => p.emits.checks.length > 0);

  it("catalog coverage: ≥14 checked packs, each check has a violating fixture + a compliant fixture", () => {
    expect(checked.length).toBeGreaterThanOrEqual(14);
    for (const p of checked) {
      for (const c of p.emits.checks)
        expect(
          p.fixture_files.some((f) => f.includes(c.id)),
          `${p.id}/${c.id} needs a violating-* fixture`,
        ).toBe(true);
      expect(
        p.fixture_files.some((f) => f.split("/").pop()!.startsWith("compliant")),
        `${p.id} needs a compliant fixture`,
      ).toBe(true);
    }
  });

  for (const pack of checked) {
    for (const check of pack.emits.checks) {
      it(`${pack.id}/${check.id}: fixture trips the real emitted gate`, () => {
        const dir = mkdtempSync(join(tmpdir(), "keel-checks-"));
        try {
          mkdirSync(join(dir, ".keel"), { recursive: true });
          writeFileSync(join(dir, ".keel", "check-packs.mjs"), CHECK_PACKS);
          const flat = { ...check, id: `${pack.id}/${check.id}` };
          writeFileSync(join(dir, ".keel", "harness.json"), JSON.stringify({ version: 1, checks: [flat] }));

          const rel = probePath(check.globs[0]);
          const dest = join(dir, rel);
          mkdirSync(dirname(dest), { recursive: true });

          const fxName = pack.fixture_files.find((f) => f.includes(check.id))!;
          writeFileSync(dest, readFileSync(join(pack.dir, fxName), "utf8"));
          const bad = runGate(dir);
          const wantExit = check.severity === "warn" ? 0 : 1;
          expect(bad.status, `${pack.id}/${check.id} should flag ${fxName}: ${bad.stderr}`).toBe(wantExit);
          expect(bad.stderr).toContain(`${pack.id}/${check.id}`);

          const cName = pack.fixture_files.find((f) => f.split("/").pop()!.startsWith("compliant"))!;
          writeFileSync(dest, readFileSync(join(pack.dir, cName), "utf8"));
          const ok = runGate(dir);
          expect(ok.status, `${pack.id}/${check.id} flagged compliant ${cName}: ${ok.stderr}`).toBe(0);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it("severity warn reports without failing the gate; error still fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-sev-"));
    try {
      mkdirSync(join(dir, ".keel"), { recursive: true });
      writeFileSync(join(dir, ".keel", "check-packs.mjs"), CHECK_PACKS);
      const mk = (severity: string) => ({
        id: `stack/t/${severity}-hit`, kind: "forbid_regex", globs: ["**/*.ts"], exclude_globs: [],
        pattern: "\\bconsole\\.log\\s*\\(", flags: "", scope: "code", severity, message: `${severity} check`,
      });
      writeFileSync(join(dir, "a.ts"), "console.log(1);\n");

      writeFileSync(join(dir, ".keel", "harness.json"), JSON.stringify({ checks: [mk("warn")] }));
      const warnRun = runGate(dir);
      expect(warnRun.status).toBe(0);
      expect(warnRun.stderr).toContain("warnings");
      expect(warnRun.stderr).toContain("stack/t/warn-hit");

      writeFileSync(join(dir, ".keel", "harness.json"), JSON.stringify({ checks: [mk("error")] }));
      expect(runGate(dir).status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keel-ignore suppresses a line only with an id match + reason; keel-ignore-file covers the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-ign-"));
    try {
      mkdirSync(join(dir, ".keel"), { recursive: true });
      writeFileSync(join(dir, ".keel", "check-packs.mjs"), CHECK_PACKS);
      const flat = {
        id: "stack/zod/no-z-any", kind: "forbid_regex", globs: ["**/*.ts"], exclude_globs: [],
        pattern: "\\bz\\.any\\s*\\(", flags: "", scope: "code", message: "no z.any",
      };
      writeFileSync(join(dir, ".keel", "harness.json"), JSON.stringify({ checks: [flat] }));

      writeFileSync(join(dir, "a.ts"), "const s = z.any(); // keel-ignore stack/zod/no-z-any: generated payload\n");
      expect(runGate(dir).status).toBe(0);

      writeFileSync(join(dir, "a.ts"), "const s = z.any(); // keel-ignore stack/zod/no-z-any\n");
      expect(runGate(dir).status).toBe(1);

      writeFileSync(join(dir, "a.ts"), "const s = z.any(); // keel-ignore other/pack: wrong id\n");
      expect(runGate(dir).status).toBe(1);

      writeFileSync(join(dir, "a.ts"), "// keel-ignore-file stack/zod/no-z-any: vendored shim\nconst s = z.any();\n");
      expect(runGate(dir).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("emission + catalog overlay", () => {
  it("compilePlan emits check-packs.mjs + flattened harness checks; coverage counts checked packs", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-emit-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"t"}');
      const plan = compilePlan(dir, parseSpec("version: 1\npacks:\n  include: [stack/vitest]\n"));
      expect(plan.ops.some((o) => o.path === ".keel/check-packs.mjs")).toBe(true);
      const harness = JSON.parse(plan.ops.find((o) => o.path === ".keel/harness.json")!.content!);
      expect(harness.checks.map((c: { id: string }) => c.id)).toContain("stack/vitest/no-focused-tests");
      expect(plan.coverage.checked).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checked pack without emits.checks is honestly downgraded to advised", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-honest-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"t"}');
      const fake = {
        id: "stack/fake", slot: "stack" as const, name: "Fake", version: "1", summary: "s",
        tags: [], stack_keys: [], principle_keys: [], stack_version: {}, paradigm: "neutral" as const,
        conflicts_with: [], token_cost: 0, enforcement: "checked" as const,
        emits: { agents_lines: [], rules: [], permissions: { allow: [], ask: [], deny: [] }, skill: false, checks: [] },
        dir: "", hash: "", skill_files: [], fixture_files: [],
      };
      const plan = compilePlan(dir, parseSpec("version: 1\npacks:\n  include: [stack/fake]\n"), {
        catalog: new Map([["stack/fake", fake]]),
      });
      expect(plan.warnings.some((w) => w.includes("stack/fake") && w.includes("advised"))).toBe(true);
      expect(plan.coverage.advised).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadCatalogOverlay: packs.dirs roots override bundled ids deterministically", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-overlay-"));
    try {
      mkdirSync(join(dir, "safety", "baseline"), { recursive: true });
      writeFileSync(
        join(dir, "safety", "baseline", "pack.yaml"),
        'id: safety/baseline\nslot: safety\nname: Local Baseline\nversion: "9"\nsummary: org override\nenforcement: advised\nemits:\n  agents_lines: ["local baseline"]\n',
      );
      mkdirSync(join(dir, "stack", "org-pack"), { recursive: true });
      writeFileSync(
        join(dir, "stack", "org-pack", "pack.yaml"),
        'id: stack/org-pack\nslot: stack\nname: Org Pack\nversion: "1"\nsummary: org only\nenforcement: advised\nemits:\n  agents_lines: ["org rule"]\n',
      );
      const { packs, overridden } = loadCatalogOverlay([catalogRoot(), dir]);
      expect(overridden).toEqual(["safety/baseline"]);
      expect(packs.get("safety/baseline")!.name).toBe("Local Baseline");
      expect(packs.get("stack/org-pack")!.name).toBe("Org Pack");
      expect(packs.size).toBe(28); // 27 bundled + 1 net-new (baseline was overridden, not added)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
