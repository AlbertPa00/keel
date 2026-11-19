import { describe, expect, it } from "vitest";
import { loadCatalog, catalogRoot } from "../src/index.js";
import { parseSpec } from "../src/spec/load.js";
import { resolvePacks } from "../src/resolve/resolve.js";
import type { Fingerprint } from "../src/fingerprint.js";

const catalog = loadCatalog(catalogRoot());

const baseFp: Fingerprint = {
  language: "typescript",
  package_manager: "pnpm",
  frameworks: {},
  monorepo: false,
  workspaces: [],
  test_runner: null,
  linter: null,
  tsconfig_strict: true,
  agent_dirs: [],
  has_agents_md: false,
  scripts: [],
};

const spec = (yaml: string) => parseSpec(`version: 1\n${yaml}`);

describe("resolvePacks", () => {
  it("selects stack packs matching declared frameworks", () => {
    const res = resolvePacks(spec("stack: { frameworks: [react] }\n"), baseFp, catalog);
    expect(res.selected.map((p) => p.id)).toContain("stack/react-composition");
    expect(res.selected.map((p) => p.id)).not.toContain("stack/prisma");
  });

  it("uses detected fingerprint frameworks too", () => {
    const res = resolvePacks(spec(""), { ...baseFp, frameworks: { prisma: "6" } }, catalog);
    expect(res.selected.map((p) => p.id)).toContain("stack/prisma");
  });

  it("always includes the safety baseline", () => {
    const res = resolvePacks(spec(""), baseFp, catalog);
    expect(res.selected.map((p) => p.id)).toContain("safety/baseline");
  });

  it("auto-includes verified-completion when autonomy != guided", () => {
    const res = resolvePacks(spec("autonomy: { mode: autonomous-verified }\n"), baseFp, catalog);
    expect(res.selected.map((p) => p.id)).toContain("workflow/verified-completion");
    const res2 = resolvePacks(spec("autonomy: { mode: guided }\n"), baseFp, catalog);
    expect(res2.selected.map((p) => p.id)).not.toContain("workflow/verified-completion");
  });

  it("drops paradigm-mismatched style packs", () => {
    const res = resolvePacks(spec("style: { paradigm: oop }\n"), baseFp, catalog);
    const ids = res.selected.map((p) => p.id);
    expect(ids).toContain("style/oop-strict");
    expect(ids).not.toContain("style/fp-strict");
    expect(res.rejected.some((r) => r.pack === "style/fp-strict" && /paradigm/.test(r.reason))).toBe(true);
  });

  it("auto-includes the declared paradigm's strict pack", () => {
    const res = resolvePacks(spec("style: { paradigm: fp }\n"), baseFp, catalog);
    const ids = res.selected.map((p) => p.id);
    expect(ids).toContain("style/fp-strict");
    expect(ids).not.toContain("style/oop-strict");
  });

  it("never picks a strict paradigm on hybrid — not even via principles", () => {
    for (const yaml of ["", "style: { paradigm: hybrid }\n", "style: { principles: [solid, dry] }\n"]) {
      const res = resolvePacks(spec(yaml), baseFp, catalog);
      const ids = res.selected.map((p) => p.id);
      expect(ids).not.toContain("style/fp-strict");
      expect(ids).not.toContain("style/oop-strict");
    }
  });

  it("hybrid still honors an explicit packs.include for a paradigm pack", () => {
    const res = resolvePacks(spec("packs: { include: [style/fp-strict] }\n"), baseFp, catalog);
    const ids = res.selected.map((p) => p.id);
    expect(ids).toContain("style/fp-strict");
    expect(ids).not.toContain("style/oop-strict");
  });

  it("resolves declared conflicts deterministically", () => {
    const res = resolvePacks(
      spec("packs: { include: [architecture/layered, architecture/hexagonal] }\n"),
      baseFp,
      catalog,
    );
    const ids = res.selected.map((p) => p.id);
    expect(ids.filter((i) => i.startsWith("architecture/"))).toHaveLength(1);
    expect(res.conflicts.length).toBeGreaterThan(0);
  });

  it("respects exclusions", () => {
    const res = resolvePacks(spec("packs: { exclude: [safety/baseline] }\n"), baseFp, catalog);
    expect(res.selected.map((p) => p.id)).not.toContain("safety/baseline");
  });

  it("filters by declared stack version", () => {
    const res = resolvePacks(spec("stack: { frameworks: [react] }\n"), { ...baseFp, frameworks: { react: "18" } }, catalog);
    // react-composition requires react 19 → rejected on version
    expect(res.rejected.some((r) => r.pack === "stack/react-composition" && /version/.test(r.reason))).toBe(true);
  });
});
