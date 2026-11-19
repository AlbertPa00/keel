import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundaryViolations, discoverArchitecture, fingerprint } from "../src/index.js";
import { CHECK_BOUNDARIES } from "../src/emit/scripts.js";

const LAYERS = [
  { name: "domain", paths: ["domain/**", "src/domain/**"], may_import: [] },
  { name: "api", paths: ["api/**", "src/api/**"], may_import: [] },
];

const harnessFor = (layers: object[], exceptions: object[] = [], aliases: object = {}) =>
  JSON.stringify({ boundaries: { layers, exceptions, aliases } });

const runChecker = (dir: string) =>
  spawnSync(process.execPath, [".keel/check-boundaries.mjs"], { cwd: dir, encoding: "utf8" });

function emitChecker(dir: string, harnessJson: string) {
  mkdirSync(join(dir, ".keel"), { recursive: true });
  writeFileSync(join(dir, ".keel", "check-boundaries.mjs"), CHECK_BOUNDARIES);
  writeFileSync(join(dir, ".keel", "harness.json"), harnessJson);
}

describe("polyglot boundary extraction", () => {
  it("python: absolute + relative imports trip the emitted gate identically to graph.ts", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-py-"));
    try {
      mkdirSync(join(dir, "domain"), { recursive: true });
      mkdirSync(join(dir, "api"), { recursive: true });
      writeFileSync(join(dir, "domain", "core.py"), "X = 1\n");
      writeFileSync(join(dir, "api", "h.py"),
        "from domain.core import X\n# from domain.other import Y\n\"\"\"from domain.fake import Z\"\"\"\n");
      emitChecker(dir, harnessFor(LAYERS));

      const graphV = boundaryViolations(dir, LAYERS, []);
      expect(graphV.length).toBe(1);
      expect(graphV[0]!.file).toBe("api/h.py");
      expect(graphV[0]!.from_layer).toBe("api");
      expect(graphV[0]!.to_layer).toBe("domain");

      const r = runChecker(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("api/h.py:1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("go: module-prefix imports + import blocks; external modules ignored", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-go-"));
    try {
      mkdirSync(join(dir, "domain"), { recursive: true });
      mkdirSync(join(dir, "api"), { recursive: true });
      writeFileSync(join(dir, "go.mod"), "module example.com/m\n\ngo 1.21\n");
      writeFileSync(join(dir, "domain", "x.go"), "package domain\n");
      writeFileSync(join(dir, "api", "h.go"),
        'package api\n\nimport (\n\tf "fmt"\n\t"example.com/m/domain"\n)\nvar _ = f.Sprint\n');
      emitChecker(dir, harnessFor(LAYERS, [], { "example.com/m": "" }));

      const graphV = boundaryViolations(dir, LAYERS, []);
      expect(graphV.length).toBe(1);
      expect(graphV[0]!.to_layer).toBe("domain");
      const r = runChecker(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("api/h.go:5");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rust: crate::/super:: + cross-crate workspace imports resolve through aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-rs-"));
    try {
      mkdirSync(join(dir, "crates", "api", "src"), { recursive: true });
      mkdirSync(join(dir, "crates", "dom", "src"), { recursive: true });
      writeFileSync(join(dir, "Cargo.toml"),
        '[workspace]\nmembers = ["crates/*"]\n');
      writeFileSync(join(dir, "crates", "api", "Cargo.toml"), '[package]\nname = "api_crate"\n');
      writeFileSync(join(dir, "crates", "dom", "Cargo.toml"), '[package]\nname = "dom_crate"\n');
      writeFileSync(join(dir, "crates", "dom", "src", "model.rs"), "pub struct M;\n");
      // self-crate import stays in layer; cross-crate use violates
      writeFileSync(join(dir, "crates", "api", "src", "h.rs"),
        "use crate::helper;\nuse dom_crate::model::M;\n// use dom_crate::other::X;\n");
      const layers = [
        { name: "dom", paths: ["crates/dom/**"], may_import: [] },
        { name: "api", paths: ["crates/api/**"], may_import: [] },
      ];
      emitChecker(dir, harnessFor(layers, [], { dom_crate: "crates/dom/src" }));

      const graphV = boundaryViolations(dir, layers, []);
      expect(graphV.length).toBe(1);
      expect(graphV[0]!.spec).toBe("dom_crate::model::M");
      const r = runChecker(dir);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("crates/api/src/h.rs:2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("polyglot fingerprint", () => {
  it("detects go/rust/python ecosystems with verify inference", () => {
    const d = mkdtempSync(join(tmpdir(), "keel-fp-"));
    try {
      const fpGo = fingerprint(mkdirGo(tmpdir()));
      expect(fpGo.language).toBe("go");
      expect(fpGo.package_manager).toBe("go");
      expect(fpGo.verify_cmds).toContain("go test ./...");
      expect(fpGo.frameworks.gin).toBeNull();

      const fpRs = fingerprint(mkdirRs(tmpdir()));
      expect(fpRs.language).toBe("rust");
      expect(fpRs.package_manager).toBe("cargo");
      expect(fpRs.verify_cmds).toContain("cargo test");
      expect(fpRs.frameworks.tokio).toBeNull();

      const fpPy = fingerprint(mkdirPy(tmpdir()));
      expect(fpPy.language).toBe("python");
      expect(fpPy.package_manager).toBe("uv");
      expect(fpPy.test_runner).toBe("pytest");
      expect(fpPy.verify_cmds).toContain("uv run pytest");
      expect(fpPy.frameworks.fastapi).toBeNull();
      expect(fpPy.frameworks.sqlalchemy).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

function mkdirGo(base: string): string {
  const d = mkdtempSync(join(base, "go-"));
  writeFileSync(join(d, "go.mod"),
    "module example.com/m\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n");
  return d;
}
function mkdirRs(base: string): string {
  const d = mkdtempSync(join(base, "rs-"));
  writeFileSync(join(d, "Cargo.toml"),
    '[package]\nname = "x"\n\n[dependencies]\ntokio = "1"\nserde = { version = "1" }\n');
  return d;
}
function mkdirPy(base: string): string {
  const d = mkdtempSync(join(base, "py-"));
  writeFileSync(join(d, "uv.lock"), "version = 1\n");
  writeFileSync(join(d, "pyproject.toml"),
    '[project]\nname = "x"\ndependencies = ["fastapi>=0.110", "sqlalchemy", "pytest"]\n');
  return d;
}

describe("keel init --discover", () => {
  it("synthesizes ordered layers for a clean DAG", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-disc-"));
    try {
      mkdirSync(join(dir, "src", "db"), { recursive: true });
      mkdirSync(join(dir, "src", "services"), { recursive: true });
      mkdirSync(join(dir, "src", "api"), { recursive: true });
      writeFileSync(join(dir, "src", "db", "q.ts"), "export const q = 1;\n");
      writeFileSync(join(dir, "src", "services", "s.ts"), "import { q } from \"../db/q\";\nexport const s = q;\n");
      writeFileSync(join(dir, "src", "api", "r.ts"),
        "import { s } from \"../services/s\";\nimport { q } from \"../db/q\";\nexport const r = s + q;\n");

      const found = discoverArchitecture(dir);
      expect(found.layers.length).toBe(3);
      expect(found.layers[0]!.name).toBe("db");
      expect(found.layers[0]!.may_import).toEqual([]);
      expect(found.layers[1]!.name).toBe("services");
      expect(found.layers[1]!.may_import).toEqual(["db"]);
      expect(found.layers[2]!.name).toBe("api");
      expect(found.layers[2]!.may_import).toEqual(["db", "services"]);
      expect(found.exceptions).toEqual([]);

      // Discovered layers must produce zero violations on the same graph.
      expect(boundaryViolations(dir, found.layers, found.exceptions)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("minority-direction edges become ratchet exceptions, not violations", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-disc2-"));
    try {
      mkdirSync(join(dir, "src", "a"), { recursive: true });
      mkdirSync(join(dir, "src", "b"), { recursive: true });
      // a → b wins 3:1; the one b→a edge is debt → exception, not a violation.
      writeFileSync(join(dir, "src", "a", "a1.ts"), "import \"../b/b1\";\n");
      writeFileSync(join(dir, "src", "a", "a2.ts"), "import \"../b/b1\";\nimport \"../b/b2\";\n");
      writeFileSync(join(dir, "src", "a", "a3.ts"), "import \"../b/b2\";\n");
      writeFileSync(join(dir, "src", "b", "b1.ts"), "export const x = 1;\n");
      writeFileSync(join(dir, "src", "b", "b2.ts"), "import \"../a/a1\";\nexport const y = 1;\n");

      const found = discoverArchitecture(dir);
      expect(found.layers.length).toBe(2);
      // b is imported by a → b is inner (first), a outer (second)
      expect(found.layers[0]!.name).toBe("b");
      expect(found.layers[1]!.name).toBe("a");
      expect(found.exceptions.length).toBe(1);
      expect(found.exceptions[0]!.file).toBe("src/b/b2.ts");
      expect(found.exceptions[0]!.allow).toEqual(["a"]);
      expect(boundaryViolations(dir, found.layers, found.exceptions)).toEqual([]);
      // without the exception the minority edge is a violation
      expect(boundaryViolations(dir, found.layers, []).length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a pure 2-cycle merges into a single layer", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-disc3-"));
    try {
      mkdirSync(join(dir, "src", "a"), { recursive: true });
      mkdirSync(join(dir, "src", "b"), { recursive: true });
      writeFileSync(join(dir, "src", "a", "x.ts"), "import \"../b/y\";\n");
      writeFileSync(join(dir, "src", "b", "y.ts"), "import \"../a/x\";\nexport const y = 1;\n");
      const found = discoverArchitecture(dir);
      expect(found.layers.length).toBe(1);
      expect(found.layers[0]!.paths.sort()).toEqual(["src/a/**", "src/b/**"]);
      expect(found.notes[0]).toContain("cycle merged");
      expect(boundaryViolations(dir, found.layers, found.exceptions)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
