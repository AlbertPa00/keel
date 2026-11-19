import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { apply, check, remove } from "../src/index.js";
import { parseSpec } from "../src/spec/load.js";

let dir: string;

const SPEC = `version: 1
targets: [devin, claude]
stack:
  language: typescript
  package_manager: pnpm
  frameworks: [react]
architecture:
  style: layered
  layers:
    - name: domain
      paths: ["src/domain/**"]
    - name: adapters
      paths: ["src/adapters/**"]
      may_import: [domain]
autonomy:
  verify: 'node -e "1"'
packs:
  include: [architecture/layered]
`;

const write = (rel: string, content: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
};
const read = (rel: string) => readFileSync(join(dir, rel), "utf8");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "keel-e2e-"));
  write(
    "package.json",
    JSON.stringify({
      name: "fixture",
      packageManager: "pnpm@9.0.0",
      scripts: { typecheck: "tsc --noEmit", test: "vitest run" },
      dependencies: { react: "^19.0.0" },
    }),
  );
  write("harness.yaml", SPEC);
  write("AGENTS.md", "# Fixture Project\n\nhand-written intro stays.\n");
  write(".devin/config.json", JSON.stringify({ permissions: { allow: ["Exec(my-custom-cmd)"] } }, null, 2));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const run = (script: string) =>
  spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8" });

describe("apply", () => {
  it("writes the full harness", () => {
    const spec = parseSpec(SPEC);
    const res = apply(dir, spec);
    expect(res.plan.errors).toEqual([]);
    expect(res.applied).toBe(true);

    // managed block appended, user content preserved
    const agents = read("AGENTS.md");
    expect(agents).toContain("hand-written intro stays");
    expect(agents).toContain("keel:begin");
    expect(agents).toContain("layered");

    // permissions merged without losing user's
    const cfg = JSON.parse(read(".devin/config.json"));
    expect(cfg.permissions.allow).toContain("Exec(my-custom-cmd)");
    expect(cfg.permissions.deny).toContain("Write(.env*)");
    expect(cfg.permissions.deny).toContain("Exec(sudo)");

    // hooks + scripts + manifest
    const hooks = JSON.parse(read(".devin/hooks.v1.json"));
    expect(hooks.Stop[0].hooks[0].command).toContain("stop-verify.mjs");
    expect(JSON.parse(read(".keel/harness.json")).boundaries.layers).toHaveLength(2);

    // claude target artifacts
    const claude = JSON.parse(read(".claude/settings.json"));
    expect(claude.permissions.deny).toContain("Edit(.env*)");
    expect(claude.hooks.Stop).toBeDefined();
    expect(existsSync(join(dir, ".claude/skills/react-composition/SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, ".devin/skills/react-composition/SKILL.md"))).toBe(true);

    // lockfile written
    expect(existsSync(join(dir, "keel.lock.json"))).toBe(true);
  });

  it("is idempotent on second apply", () => {
    const res = apply(dir, parseSpec(SPEC));
    expect(res.written.length).toBeLessThanOrEqual(1); // lockfile timestamp only
  });
});

describe("boundary enforcement (generated script, real run)", () => {
  it("fails on an outward import and passes when fixed", () => {
    write("src/adapters/repo.ts", "export const repo = 1;\n");
    write("src/domain/store.ts", 'import { repo } from "../adapters/repo.js";\nexport const x = repo;\n');
    const bad = run(".keel/check-boundaries.mjs");
    expect(bad.status).toBe(1);
    expect(bad.stderr + bad.stdout).toMatch(/domain.*cannot import.*adapters/);

    const badVerify = run(".keel/verify.mjs");
    expect(badVerify.status).toBe(1);

    write("src/domain/store.ts", "export const x = 1;\n");
    expect(run(".keel/check-boundaries.mjs").status).toBe(0);
    expect(run(".keel/verify.mjs").status).toBe(0);
  });
});

describe("check / drift", () => {
  it("is clean right after apply", () => {
    const res = check(dir, parseSpec(SPEC));
    expect(res.modified).toEqual([]);
    expect(res.missing).toEqual([]);
  });

  it("detects hand-edited and deleted files", () => {
    // User edits outside the managed block are allowed; edits inside it are drift.
    write("AGENTS.md", read("AGENTS.md").replace("layered", "TAMPERED"));
    rmSync(join(dir, ".devin/rules/layer-boundaries.md"));
    const res = check(dir, parseSpec(SPEC));
    expect(res.modified).toContain("AGENTS.md");
    expect(res.missing).toContain(".devin/rules/layer-boundaries.md");
    expect(res.ok).toBe(false);
  });
});

describe("remove", () => {
  it("restores merged files and deletes created ones", () => {
    apply(dir, parseSpec(SPEC)); // restore state after tampering
    const res = remove(dir);

    const agents = read("AGENTS.md");
    expect(agents).not.toContain("keel:begin");
    expect(agents).toContain("hand-written intro stays");

    const cfg = JSON.parse(read(".devin/config.json"));
    expect(cfg.permissions.allow).toEqual(["Exec(my-custom-cmd)"]);
    expect(cfg.permissions.deny).toBeUndefined();

    expect(existsSync(join(dir, ".keel"))).toBe(false);
    expect(existsSync(join(dir, "keel.lock.json"))).toBe(false);
    expect(existsSync(join(dir, ".devin/skills"))).toBe(false);
    expect(existsSync(join(dir, ".claude"))).toBe(false);
    expect(res.removed.length).toBeGreaterThan(0);
  });
});
