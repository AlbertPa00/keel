import { describe, expect, it } from "vitest";
import { mergeHooks, mergePermissions, stripHooks, stripPermissions } from "../src/emit/jsonMerge.js";

describe("mergePermissions", () => {
  it("unions entries and reports only new additions", () => {
    const { merged, added } = mergePermissions(
      { allow: ["Read(**)"] },
      { allow: ["Read(**)", "Write(src/**)"], ask: [], deny: [] },
    );
    expect(merged.allow).toEqual(["Read(**)", "Write(src/**)"]);
    expect(added.allow).toEqual(["Write(src/**)"]);
  });

  it("deny wins — removes the entry from weaker lists", () => {
    const { merged } = mergePermissions(
      { allow: ["Write(.env*)"], ask: [], deny: [] },
      { allow: [], ask: [], deny: ["Write(.env*)"] },
    );
    expect(merged.allow).toEqual([]);
    expect(merged.deny).toEqual(["Write(.env*)"]);
  });

  it("never weakens an existing deny", () => {
    const { merged, added } = mergePermissions(
      { allow: [], ask: [], deny: ["Exec(rm -rf)"] },
      { allow: ["Exec(rm -rf)"], ask: [], deny: [] },
    );
    expect(merged.deny).toEqual(["Exec(rm -rf)"]);
    expect(added.allow).toEqual([]);
  });

  it("strip removes exactly the added entries", () => {
    const cur = { allow: ["Read(**)", "Write(src/**)"], ask: [], deny: ["Exec(sudo)"] };
    expect(stripPermissions(cur, { allow: ["Write(src/**)"], ask: [], deny: ["Exec(sudo)"] })).toEqual({
      allow: ["Read(**)"],
      ask: [],
      deny: [],
    });
  });
});

describe("mergeHooks", () => {
  const entry = (cmd: string) => ({ matcher: "", hooks: [{ type: "command", command: cmd }] });

  it("appends missing commands and drops stale keel commands", () => {
    const existing = {
      Stop: [entry("node .keel/hooks/old.mjs"), entry("./user-script.sh")],
    };
    const desired = { Stop: [entry("node .keel/hooks/stop-verify.mjs")] };
    const { merged, added } = mergeHooks(existing, desired);
    expect(merged.Stop!.flatMap((e) => e.hooks.map((h) => h.command))).toEqual([
      "./user-script.sh",
      "node .keel/hooks/stop-verify.mjs",
    ]);
    expect(added).toEqual(["node .keel/hooks/stop-verify.mjs"]);
  });

  it("is idempotent", () => {
    const desired = { Stop: [entry("node .keel/hooks/stop-verify.mjs")] };
    const once = mergeHooks({}, desired).merged;
    const twice = mergeHooks(once, desired);
    expect(twice.added).toEqual([]);
    expect(twice.merged.Stop!).toHaveLength(1);
  });

  it("strip removes hook commands", () => {
    const merged = mergeHooks({}, { Stop: [entry("node .keel/hooks/x.mjs"), entry("./keep.sh")] }).merged;
    const stripped = stripHooks(merged, ["node .keel/hooks/x.mjs"]);
    expect(stripped.Stop!.flatMap((e) => e.hooks.map((h) => h.command))).toEqual(["./keep.sh"]);
  });
});
