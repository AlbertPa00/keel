import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, catalogRoot, draftSpec, fingerprint, loadCatalog } from "../src/index.js";
import { parseSpec } from "../src/spec/load.js";

describe("seed catalog integrity", () => {
  const catalog = loadCatalog(catalogRoot());

  it("loads all 27 seed packs", () => {
    expect(catalog.size).toBe(27);
    let nChecks = 0;
    for (const p of catalog.values()) nChecks += p.emits.checks.length;
    expect(nChecks).toBeGreaterThanOrEqual(22);
  });

  it("enforces honesty: every enforced pack ships permissions, rules, or fixtures", () => {
    for (const p of catalog.values()) {
      const perms = p.emits.permissions;
      const hasEnforcer =
        perms.allow.length + perms.ask.length + perms.deny.length > 0 ||
        p.emits.rules.length > 0 ||
        p.emits.checks.length > 0 ||
        p.fixture_files.length > 0 ||
        p.id === "workflow/verified-completion";
      if (!hasEnforcer) expect(p.enforcement).not.toBe("enforced");
    }
  });

  it("has symmetric or valid conflict references", () => {
    for (const p of catalog.values()) {
      for (const c of p.conflicts_with) expect(catalog.has(c)).toBe(true);
    }
  });
});

describe("lifecycle hook scripts (real execution)", () => {
  it("stop-verify blocks on failure (exit 2), passes on stop_hook_active, passes on green verify", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-hooks-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }), "utf8");

      // Failing verify → exit 2 (blocks stop)
      apply(dir, parseSpec('version: 1\nautonomy:\n  verify: \'node -e "process.exit(1)"\'\n'));
      const blocked = spawnSync(process.execPath, [".keel/hooks/stop-verify.mjs"], {
        cwd: dir,
        input: JSON.stringify({ stop_hook_active: false }),
        encoding: "utf8",
      });
      expect(blocked.status).toBe(2);

      // Loop guard: stop_hook_active=true → exit 0 immediately
      const guarded = spawnSync(process.execPath, [".keel/hooks/stop-verify.mjs"], {
        cwd: dir,
        input: JSON.stringify({ stop_hook_active: true }),
        encoding: "utf8",
      });
      expect(guarded.status).toBe(0);

      // Passing verify → exit 0
      apply(dir, parseSpec('version: 1\nautonomy:\n  verify: \'node -e "0"\'\n'));
      const ok = spawnSync(process.execPath, [".keel/hooks/stop-verify.mjs"], {
        cwd: dir,
        input: "{}",
        encoding: "utf8",
      });
      expect(ok.status).toBe(0);

      // post-compaction prints invariants and exits 0
      const compact = spawnSync(process.execPath, [".keel/hooks/post-compaction.mjs"], {
        cwd: dir,
        input: "{}",
        encoding: "utf8",
      });
      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("Active harness invariants");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshot-aware stop: unchanged worktree skips verify, any mutation runs it", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-dirty-"));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }), "utf8");
      apply(dir, parseSpec('version: 1\nautonomy:\n  verify: \'node -e "process.exit(1)"\'\n'));

      const hook = (name: string, payload: unknown) =>
        spawnSync(process.execPath, [`.keel/hooks/${name}`], {
          cwd: dir,
          input: JSON.stringify(payload),
          encoding: "utf8",
        });

      // turn stamps a worktree snapshot; nothing changed → stop exits 0 without running verify
      hook("turn-stamp.mjs", { session_id: "s1", prompt_id: "p1" });
      expect(hook("stop-verify.mjs", { stop_hook_active: false }).status).toBe(0);

      // harness-internal churn (.keel/state writes) never marks a turn dirty
      writeFileSync(join(dir, ".keel/state/noise.txt"), "x", "utf8");
      expect(hook("stop-verify.mjs", { stop_hook_active: false }).status).toBe(0);

      // a real mutation (any tool — the snapshot is the truth) → verify runs → blocks
      writeFileSync(join(dir, "changed.txt"), "x", "utf8");
      expect(hook("stop-verify.mjs", { stop_hook_active: false }).status).toBe(2);

      // next turn: new snapshot includes changed.txt; an unlisted read-only command
      // (e.g. wc/jq — no fs change) leaves the snapshot identical → verify skipped
      hook("turn-stamp.mjs", { session_id: "s1", prompt_id: "p2" });
      expect(hook("stop-verify.mjs", { stop_hook_active: false }).status).toBe(0);

      // mutation through an "unknown" command equivalent still caught: snapshot differs
      writeFileSync(join(dir, "another.ts"), "export {};\n", "utf8");
      expect(hook("stop-verify.mjs", { stop_hook_active: false }).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("snapshot uses git porcelain inside a git worktree", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-git-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "t" }), "utf8");
      writeFileSync(join(dir, ".gitignore"), "node_modules/\n.keel/state/\n", "utf8");
      spawnSync("git", ["init", "-q"], { cwd: dir });
      apply(dir, parseSpec('version: 1\nautonomy:\n  verify: \'node -e "process.exit(1)"\'\n'));

      const hook = (name: string, payload: unknown) =>
        spawnSync(process.execPath, [`.keel/hooks/${name}`], {
          cwd: dir,
          input: JSON.stringify(payload),
          encoding: "utf8",
        });

      hook("turn-stamp.mjs", { session_id: "g1", prompt_id: "p1" });
      const key = readFileSync(join(dir, ".keel/state/current"), "utf8").trim();
      expect(readFileSync(join(dir, `.keel/state/${key}.snap`), "utf8")).toMatch(/^g:/);
      expect(hook("stop-verify.mjs", {}).status).toBe(0);

      writeFileSync(join(dir, "mut.ts"), "export {};\n", "utf8");
      expect(hook("stop-verify.mjs", {}).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("draftSpec + fingerprint", () => {
  it("detects stack and surfaces conflicts with intent", () => {
    const dir = mkdtempSync(join(tmpdir(), "keel-fp-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "demo",
          packageManager: "pnpm@9.0.0",
          scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "jest" },
          dependencies: { express: "^5.0.0", "@prisma/client": "^6.0.0" },
          devDependencies: { jest: "^29.0.0", eslint: "^9.0.0" },
        }),
        "utf8",
      );
      const fp = fingerprint(dir);
      expect(fp.package_manager).toBe("pnpm");
      expect(fp.test_runner).toBe("jest");
      expect(fp.frameworks).toMatchObject({ express: "5", prisma: "6" });

      const draft = draftSpec(fp, "hexagonal fp backend with vitest and solid");
      expect(draft.spec.architecture.style).toBe("hexagonal");
      expect(draft.spec.style.paradigm).toBe("fp");
      expect(draft.spec.style.principles).toContain("solid");
      expect(draft.conflicts.some((c) => /vitest.*jest/i.test(c))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
