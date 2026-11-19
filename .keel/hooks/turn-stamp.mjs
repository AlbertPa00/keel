#!/usr/bin/env node
// keel: UserPromptSubmit hook — stamp the current turn and snapshot the worktree.
// The stop hook later compares a fresh snapshot: an identical tree means the
// turn provably changed nothing and verify is skipped — no command guessing.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stateDir = join(root, ".keel", "state");

// Worktree snapshot — the authoritative "did this turn change anything" check.
// git status --porcelain covers tracked + untracked changes in one call; the
// mtime fallback keeps non-git directories working. .keel/state/ is always
// excluded — harness-internal churn is not user mutation.
import * as __snapFs from "node:fs";
import { spawnSync as __snapSpawn } from "node:child_process";
import { createHash as __snapHash } from "node:crypto";

const SNAP_IGNORE = /^(node_modules|dist|coverage|\.git|\.keel\/state)\//;
const worktreeSnap = (root) => {
  const git = __snapSpawn("git", ["status", "--porcelain=v2", "-uall", "--", "."], { cwd: root, encoding: "utf8" });
  if (git.status === 0 && typeof git.stdout === "string") {
    const body = git.stdout.split("\n").filter((l) => !l.includes(".keel/state")).join("\n");
    return "g:" + __snapHash("sha256").update(body).digest("hex");
  }
  const parts = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = __snapFs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (SNAP_IGNORE.test(r + (e.isDirectory() ? "/" : ""))) continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else {
        try { const st = __snapFs.statSync(join(dir, e.name)); parts.push(r + ":" + st.size + ":" + st.mtimeMs); }
        catch { /* vanished mid-scan */ }
      }
    }
  };
  walk(root, "");
  parts.sort();
  return "f:" + __snapHash("sha256").update(parts.join("\n")).digest("hex");
};


let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const key = `${payload.session_id ?? "s"}:${payload.prompt_id ?? "p"}`.replace(/[^\w.-]/g, "_");
    mkdirSync(stateDir, { recursive: true });
    // a new turn starts clean — sweep markers from finished/abandoned turns
    for (const f of readdirSync(stateDir)) if (f.endsWith(".dirty") || f.endsWith(".snap")) rmSync(join(stateDir, f), { force: true });
    writeFileSync(join(stateDir, "current"), key, "utf8");
    writeFileSync(join(stateDir, key + ".snap"), worktreeSnap(root), "utf8");
  } catch { /* best effort — never block a prompt */ }
  process.exit(0);
});
