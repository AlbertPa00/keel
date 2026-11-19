import { describe, expect, it } from "vitest";
import { MANAGED, stripManagedBlock, upsertManagedBlock } from "../src/emit/managed.js";

const BODY = "- line one\n- line two";

describe("managed blocks", () => {
  it("creates a block in an empty file", () => {
    const { content } = upsertManagedBlock(null, BODY);
    expect(content).toContain(MANAGED.begin);
    expect(content).toContain(BODY);
  });

  it("replaces an existing block without touching surrounding text", () => {
    const first = upsertManagedBlock(null, "old body").content;
    const withUser = `# My Project\n\nuser text above\n\n${first}user text below\n`;
    const { content } = upsertManagedBlock(withUser, BODY);
    expect(content).toContain(BODY);
    expect(content).not.toContain("old body");
    expect(content).toContain("user text above");
    expect(content).toContain("user text below");
  });

  it("appends a block to a file with no block", () => {
    const { content } = upsertManagedBlock("# Title\n", BODY);
    expect(content.indexOf("# Title")).toBeLessThan(content.indexOf(MANAGED.begin));
  });

  it("strips a block and keeps the rest", () => {
    const full = `top\n\n${upsertManagedBlock(null, BODY).content}bottom\n`;
    const stripped = stripManagedBlock(full)!;
    expect(stripped).toContain("top");
    expect(stripped).toContain("bottom");
    expect(stripped).not.toContain("keel:begin");
  });

  it("returns null when only the block remains", () => {
    expect(stripManagedBlock(upsertManagedBlock(null, BODY).content)).toBeNull();
  });
});
