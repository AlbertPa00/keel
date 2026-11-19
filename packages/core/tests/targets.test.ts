import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, check, fingerprint, remove } from "../src/index.js";
import { parseSpec } from "../src/spec/load.js";

const write = (dir: string, rel: string, content: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
};
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

const SPEC_ALL = `version: 1
targets: [devin, claude, cursor, windsurf, copilot, codex]
architecture:
  style: layered
  layers:
    - { name: domain, paths: ["src/domain/**"] }
    - { name: adapters, paths: ["src/adapters/**"], may_import: [domain] }
autonomy: { verify: 'node -e "0"' }
packs:
  include: [architecture/layered, stack/vitest]
`;

describe("universal targets", () => {
  it("emits cursor .mdc, windsurf rules, copilot instructions + managed block", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-targets-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t", devDependencies: { vitest: "^3.0.0" } }));
      const res = apply(dir, parseSpec(SPEC_ALL));
      expect(res.applied).toBe(true);

      const cursor = read(dir, ".cursor/rules/keel-vitest-conventions.mdc");
      expect(cursor).toContain("alwaysApply:");
      expect(cursor).toContain("globs:");

      const ws = read(dir, ".windsurf/rules/keel-layer-boundaries.md");
      expect(ws).toContain("trigger: glob");

      const copilot = read(dir, ".github/copilot-instructions.md");
      expect(copilot).toContain("keel:begin");
      const instr = read(dir, ".github/instructions/keel-layer-boundaries.instructions.md");
      expect(instr).toContain("applyTo:");

      // codex: AGENTS.md only
      expect(res.plan.warnings.some((w) => w.includes("codex"))).toBe(true);

      // remove leaves no residue for any target
      remove(dir);
      expect(existsSync(join(dir, ".cursor"))).toBe(false);
      expect(existsSync(join(dir, ".windsurf"))).toBe(false);
      expect(existsSync(join(dir, ".github", "instructions"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ci gate", () => {
  it("autonomy.ci: github emits workflow + drift checker that catches tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-ci-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t", scripts: { test: "echo ok" } }));
      apply(dir, parseSpec('version: 1\nautonomy:\n  verify: \'node -e "0"\'\n  ci: github\n'));

      const wf = read(dir, ".github/workflows/keel-verify.yml");
      expect(wf).toContain("check-drift.mjs");
      expect(wf).toContain("verify.mjs");
      expect(existsSync(join(dir, ".keel/check-drift.mjs"))).toBe(true);

      // clean tree → drift check passes
      expect(spawnSync(process.execPath, [".keel/check-drift.mjs"], { cwd: dir }).status).toBe(0);

      // hand-edit a managed file → drift detected
      const cfg = read(dir, ".devin/config.json").replace("allow", "allowX");
      write(dir, ".devin/config.json", cfg);
      const bad = spawnSync(process.execPath, [".keel/check-drift.mjs"], { cwd: dir, encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stderr + bad.stdout).toMatch(/modified.*devin\/config\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stale ratchet enforcement", () => {
  it("a fixed file turns its exception entry stale and the gate fails until removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-stale-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t" }));
      apply(
        dir,
        parseSpec(`version: 1
architecture:
  layers:
    - { name: domain, paths: ["src/domain/**"] }
    - { name: adapters, paths: ["src/adapters/**"], may_import: [domain] }
  exceptions:
    - file: src/domain/legacy.ts
      allow: [adapters]
autonomy: { verify: 'node -e "0"' }
`),
      );
      write(dir, "src/adapters/db.ts", "export const db = 1;\n");
      write(dir, "src/domain/legacy.ts", 'import { db } from "../adapters/db.js";\nexport const x = db;\n');
      // violation still present → exception used → gate green
      expect(spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir }).status).toBe(0);

      // fix the file → exception becomes stale → gate fails with shrink-only message
      write(dir, "src/domain/legacy.ts", "export const x = 1;\n");
      const res = spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir, encoding: "utf8" });
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/stale ratchet entries/);
      expect(res.stderr + res.stdout).toMatch(/legacy\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fingerprint target detection", () => {
  it("detects cursor, windsurf, copilot, codex dirs", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-fp2-"));
    try {
      mkdirSync(join(dir, ".cursor"), { recursive: true });
      mkdirSync(join(dir, ".windsurf"), { recursive: true });
      mkdirSync(join(dir, ".codex"), { recursive: true });
      write(dir, ".github/copilot-instructions.md", "# notes\n");
      const fp = fingerprint(dir);
      for (const t of ["cursor", "windsurf", "copilot", "codex"]) expect(fp.agent_dirs).toContain(t);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("plan stability across all targets", () => {
  it("check is green right after a six-target apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-six-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t" }));
      const spec = parseSpec(SPEC_ALL.replace("ci: github\n", ""));
      apply(dir, spec);
      const res = check(dir, spec);
      expect(res.modified).toEqual([]);
      expect(res.missing).toEqual([]);
      expect(res.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
