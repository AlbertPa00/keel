import { describe, expect, it } from "vitest";
import { bestGlobMatch, globBaseDir, matchesGlob } from "../src/util/glob.js";

describe("globToRegex", () => {
  it("matches dir/** recursively", () => {
    expect(matchesGlob("src/domain/a/b.ts", "src/domain/**")).toBe(true);
    expect(matchesGlob("src/other/b.ts", "src/domain/**")).toBe(false);
  });

  it("single star stays within a segment", () => {
    expect(matchesGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "src/*.ts")).toBe(false);
  });

  it("escapes regex chars", () => {
    expect(matchesGlob("a.b/x.ts", "a.b/*.ts")).toBe(true);
    expect(matchesGlob("axb/x.ts", "a.b/*.ts")).toBe(false);
  });

  it("**/ prefix matches zero or more leading segments", () => {
    expect(matchesGlob("index.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/index.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("atoms/Button.tsx", "**/atoms/**")).toBe(true);
    expect(matchesGlob("src/ui/atoms/Button.tsx", "**/atoms/**")).toBe(true);
    expect(matchesGlob("src/molecules/x.tsx", "**/atoms/**")).toBe(false);
  });
});

describe("bestGlobMatch", () => {
  it("picks the longest literal head", () => {
    expect(bestGlobMatch("src/domain/x.ts", ["src/**", "src/domain/**"])).toBe("src/domain/**");
  });
  it("returns null when nothing matches", () => {
    expect(bestGlobMatch("lib/x.ts", ["src/**"])).toBeNull();
  });
});

describe("globBaseDir", () => {
  it("extracts the static prefix", () => {
    expect(globBaseDir("src/domain/**")).toBe("src/domain");
    expect(globBaseDir("src/*/x.ts")).toBe("src");
  });
});
