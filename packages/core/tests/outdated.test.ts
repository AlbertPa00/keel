import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, outdated, parseSpec } from "../src/index.js";
import type { Pack } from "../src/catalog/pack.js";

const pack = (version: string, hash = "h1"): Pack => ({
  id: "stack/tp",
  slot: "stack",
  name: "TP",
  version,
  summary: "s",
  tags: [],
  stack_keys: [],
  principle_keys: [],
  stack_version: {},
  paradigm: "neutral",
  conflicts_with: [],
  token_cost: 0,
  enforcement: "advised",
  emits: { agents_lines: [], rules: [], permissions: { allow: [], ask: [], deny: [] }, skill: false, checks: [] },
  dir: "",
  hash,
  skill_files: [],
  fixture_files: [],
});

const SPEC = "version: 1\ntargets: [devin]\npacks:\n  include: [stack/tp]\n";

describe("keel outdated — pack drift vs lockfile", () => {
  it("reports missing lockfile before first apply", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-out-"));
    try {
      const res = outdated(dir, parseSpec(SPEC), { catalog: new Map([["stack/tp", pack("1.0.0")]]) });
      expect(res.lock_missing).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clean right after apply; flags version bump, content edit, added and removed packs", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-out-"));
    try {
      writeFileSync(join(dir, "package.json"), '{"name":"t"}');
      const spec = parseSpec(SPEC);
      const opts = { catalog: new Map([["stack/tp", pack("1.0.0")]]) };
      apply(dir, spec, opts);
      expect(outdated(dir, spec, opts).entries).toEqual([]);

      const bumped = outdated(dir, spec, { catalog: new Map([["stack/tp", pack("1.1.0")]]) });
      expect(bumped.entries).toEqual([{ id: "stack/tp", kind: "version", locked: "1.0.0", current: "1.1.0" }]);

      const edited = outdated(dir, spec, { catalog: new Map([["stack/tp", pack("1.0.0", "h2")]]) });
      expect(edited.entries[0]!.kind).toBe("content");

      const spec2 = parseSpec("version: 1\ntargets: [devin]\npacks:\n  include: [stack/tp, stack/np]\n");
      const cat2 = new Map([["stack/tp", pack("1.0.0")], ["stack/np", { ...pack("1.0.0"), id: "stack/np" }]]);
      const added = outdated(dir, spec2, { catalog: cat2 });
      expect(added.entries.some((e) => e.kind === "added" && e.id === "stack/np")).toBe(true);

      const spec3 = parseSpec("version: 1\ntargets: [devin]\npacks:\n  include: []\n");
      const removed = outdated(dir, spec3, { catalog: new Map() });
      expect(removed.entries.some((e) => e.kind === "removed" && e.id === "stack/tp")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
