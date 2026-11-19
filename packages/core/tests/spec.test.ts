import { describe, expect, it } from "vitest";
import { mergeLocalSpec, mergeTaste, parseLocalSpec, parseSpec } from "../src/spec/load.js";
import { upsertExceptionsYaml, violationsToExceptions } from "../src/spec/ratchet.js";

const MIN = "version: 1\n";

describe("parseSpec", () => {
  it("fills defaults for a minimal spec", () => {
    const spec = parseSpec(MIN);
    expect(spec.stack.package_manager).toBe("pnpm");
    expect(spec.autonomy.mode).toBe("autonomous-verified");
    expect(spec.targets).toEqual(["devin"]);
    expect(spec.budget.max_skills).toBe(5);
  });

  it("rejects unknown fields with a readable error", () => {
    expect(() => parseSpec("version: 1\nstack: { language: 42 }\n")).toThrow(/Invalid harness spec/);
  });

  it("parses architecture layers", () => {
    const spec = parseSpec(`version: 1
architecture:
  layers:
    - name: domain
      paths: ["src/domain/**"]
    - name: adapters
      paths: ["src/adapters/**"]
      may_import: [domain]
`);
    expect(spec.architecture.layers).toHaveLength(2);
    expect(spec.architecture.layers[1]!.may_import).toEqual(["domain"]);
  });

  it("parses architecture exceptions (the ratchet)", () => {
    const spec = parseSpec(`version: 1
architecture:
  exceptions:
    - file: src/lib/legacy.ts
      allow: [adapters]
  layers:
    - { name: domain, paths: ["src/domain/**"] }
`);
    expect(spec.architecture.exceptions).toEqual([{ file: "src/lib/legacy.ts", allow: ["adapters"] }]);
  });
});

describe("mergeTaste", () => {
  it("fills only default fields — spec wins", () => {
    const spec = parseSpec("version: 1\nstyle: { paradigm: oop }\n");
    const merged = mergeTaste(spec, { paradigm: "fp", max_function_lines: 15 });
    expect(merged.style.paradigm).toBe("oop"); // spec wins
    expect(merged.style.max_function_lines).toBe(15); // taste fills
  });

  it("does not inject unrelated taste keys into style", () => {
    const spec = parseSpec(MIN);
    const merged = mergeTaste(spec, { paradigm: "fp", safety: { profile: "strict" } });
    expect(merged.style.paradigm).toBe("fp");
    expect(merged.safety.profile).toBe("strict");
    expect("safety" in merged.style).toBe(false);
  });
});

describe("harness.local.yaml merge", () => {
  it("local overrides only the fields it sets — committed wins elsewhere", () => {
    const committed = parseSpec(`version: 1
style: { paradigm: oop, comments: minimal }
autonomy: { verify: "pnpm check", stop_hook: true }
`);
    const local = parseLocalSpec('autonomy: { stop_hook: false }\nstyle: { paradigm: fp }\n', "harness.local.yaml");
    const merged = mergeLocalSpec(committed, local);
    expect(merged.autonomy.stop_hook).toBe(false); // local wins
    expect(merged.autonomy.verify).toBe("pnpm check"); // committed survives
    expect(merged.style.paradigm).toBe("fp"); // local wins
    expect(merged.style.comments).toBe("minimal"); // committed survives
  });

  it("rejects unknown top-level keys in the local spec", () => {
    expect(() => parseLocalSpec('autonomie: {}\n', "harness.local.yaml")).toThrow();
  });
});

describe("ratchet yaml surgery", () => {
  it("inserts an exceptions block under architecture:", () => {
    const yaml = `version: 1
architecture:
  layers:
    - { name: domain, paths: ["src/domain/**"] }
style:
  paradigm: fp
`;
    const out = upsertExceptionsYaml(yaml, [{ file: "src/domain/old.ts", allow: ["adapters"] }]);
    expect(out).toContain("exceptions:");
    expect(out).toContain("- file: src/domain/old.ts");
    expect(out).toContain("allow: [adapters]");
    expect(out.indexOf("exceptions:")).toBeLessThan(out.indexOf("style:")); // stays inside architecture
    expect(out).toContain("paradigm: fp");
  });

  it("replaces an existing exceptions block, preserving comments elsewhere", () => {
    const yaml = `version: 1
architecture:
  # keep me
  exceptions:
    - file: src/old.ts
      allow: [adapters]
  layers:
    - { name: domain, paths: ["src/domain/**"] }
`;
    const out = upsertExceptionsYaml(yaml, [{ file: "src/new.ts", allow: ["x"] }]);
    expect(out).toContain("# keep me");
    expect(out).not.toContain("src/old.ts");
    expect(out).toContain("src/new.ts");
  });

  it("groups violations by file into sorted exception entries", () => {
    const entries = violationsToExceptions(
      [
        { file: "b.ts", line: 1, from_layer: "a", to_layer: "z", spec: "./z" },
        { file: "b.ts", line: 9, from_layer: "a", to_layer: "y", spec: "./y" },
        { file: "a.ts", line: 2, from_layer: "a", to_layer: "z", spec: "./z" },
      ],
      [],
    );
    expect(entries).toEqual([
      { file: "a.ts", allow: ["z"] },
      { file: "b.ts", allow: ["y", "z"] },
    ]);
  });
});
