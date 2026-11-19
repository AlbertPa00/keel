import { describe, expect, it } from "vitest";
import { toClaudePerm } from "../src/emit/claude.js";

describe("toClaudePerm", () => {
  it("translates Exec to Bash prefix glob", () => {
    expect(toClaudePerm("Exec(pnpm run)")).toEqual(["Bash(pnpm run:*)"]);
    expect(toClaudePerm("Exec(git push)")).toEqual(["Bash(git push:*)"]);
  });
  it("maps Write to Write+Edit pair", () => {
    expect(toClaudePerm("Write(.env*)")).toEqual(["Write(.env*)", "Edit(.env*)"]);
  });
  it("passes Read and mcp through", () => {
    expect(toClaudePerm("Read(**)")).toEqual(["Read(**)"]);
    expect(toClaudePerm("mcp__github__*")).toEqual(["mcp__github__*"]);
  });
  it("tool-level exec becomes Bash", () => {
    expect(toClaudePerm("exec")).toEqual(["Bash"]);
  });
});
