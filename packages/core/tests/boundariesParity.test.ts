import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, boundaryViolations } from "../src/index.js";
import { parseSpec } from "../src/spec/load.js";

const write = (dir: string, rel: string, content: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content, "utf8");
};

describe("boundary parity: emitted checker sees what importGraph sees", () => {
  it("catches @scope/pkg workspace imports across layers", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-ws-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "mono" }));
      write(dir, "pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
      write(dir, "packages/domain/package.json", JSON.stringify({ name: "@acme/domain" }));
      write(dir, "packages/adapters/package.json", JSON.stringify({ name: "@acme/adapters" }));
      apply(
        dir,
        parseSpec(`version: 1
architecture:
  layers:
    - { name: domain, paths: ["packages/domain/**"] }
    - { name: adapters, paths: ["packages/adapters/**"], may_import: [domain] }
autonomy: { verify: 'node -e "0"' }
`),
      );
      write(dir, "packages/adapters/src/index.ts", "export const db = 1;\n");
      write(dir, "packages/domain/src/store.ts", 'import { db } from "@acme/adapters";\nexport const x = db;\n');

      // emitted gate must fail — previously it silently dropped @scope/pkg specifiers
      const res = spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir, encoding: "utf8" });
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/domain.*cannot import.*adapters/);

      // graph sees the same edge (parity, not just failure)
      const v = boundaryViolations(dir, [
        { name: "domain", paths: ["packages/domain/**"], may_import: [] },
        { name: "adapters", paths: ["packages/adapters/**"], may_import: ["domain"] },
      ], []);
      expect(v.some((x) => x.from_layer === "domain" && x.to_layer === "adapters")).toBe(true);

      write(dir, "packages/domain/src/store.ts", "export const x = 1;\n");
      expect(spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir }).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves tsconfig compilerOptions.paths aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-paths-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t" }));
      write(
        dir,
        "tsconfig.json",
        JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "#db/*": ["src/adapters/*"] } } }),
      );
      apply(
        dir,
        parseSpec(`version: 1
architecture:
  layers:
    - { name: domain, paths: ["src/domain/**"] }
    - { name: adapters, paths: ["src/adapters/**"], may_import: [domain] }
autonomy: { verify: 'node -e "0"' }
`),
      );
      write(dir, "src/adapters/client.ts", "export const db = 1;\n");
      write(dir, "src/domain/a.ts", 'import { db } from "#db/client";\nexport const x = db;\n');

      const res = spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir, encoding: "utf8" });
      expect(res.status).toBe(1);
      expect(res.stderr + res.stdout).toMatch(/cannot import/);
      const aliases = JSON.parse(readFileSync(join(dir, ".keel/harness.json"), "utf8")).boundaries.aliases;
      expect(aliases["#db/*"]).toBe("src/adapters/*");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tiered verify", () => {
  it("verify.mjs --fast runs verify_fast, not the full verify list", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-fast-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t" }));
      apply(
        dir,
        parseSpec(`version: 1
autonomy:
  verify: 'node -e "process.exit(1)"'
  verify_fast: 'node -e "process.exit(0)"'
`),
      );
      const harness = JSON.parse(readFileSync(join(dir, ".keel/harness.json"), "utf8"));
      expect(harness.verify_fast).toEqual(['node -e "process.exit(0)"']);
      expect(spawnSync(process.execPath, [".keel/verify.mjs"], { cwd: dir }).status).toBe(1);
      expect(spawnSync(process.execPath, [".keel/verify.mjs", "--fast"], { cwd: dir }).status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("style gate masking", () => {
  it("ignores braces inside strings, templates, and comments", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-style-"));
    try {
      write(dir, "package.json", JSON.stringify({ name: "t" }));
      apply(
        dir,
        parseSpec(`version: 1
style: { max_nesting: 2 }
autonomy: { verify: 'node -e "0"' }
`),
      );
      write(
        dir,
        "src/strings.ts",
        [
          'const a = "{ { { { { {";',
          "const b = `} { { } { }`;",
          "// { { { { comment",
          "/* { { { { block */",
          "const re = /\\{3\\}/;",
          "export const x = a;",
        ].join("\n"),
      );
      expect(spawnSync(process.execPath, [".keel/check-style.mjs"], { cwd: dir }).status).toBe(0);

      write(
        dir,
        "src/deep.ts",
        "export function f() {\n  if (a) {\n    if (b) {\n      g();\n    }\n  }\n}\n",
      );
      const bad = spawnSync(process.execPath, [".keel/check-style.mjs"], { cwd: dir, encoding: "utf8" });
      expect(bad.status).toBe(1);
      expect(bad.stderr + bad.stdout).toMatch(/nesting depth 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
