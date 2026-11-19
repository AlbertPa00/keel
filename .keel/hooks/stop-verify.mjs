#!/usr/bin/env node
// keel: Stop hook — verify once per mutated turn; block premature completion (exit 2).
// Turn dirtiness is proven by comparing worktree snapshots, not by guessing
// which shell commands mutate — unknown read-only commands cost zero verify.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
    if (payload.stop_hook_active) process.exit(0); // avoid infinite block loop
  } catch { /* ignore */ }

  // Snapshot check: identical worktree → nothing mutated → skip the gate.
  // Missing stamp/snapshot (resumed session, hooks added mid-session) → verify conservatively.
  try {
    const key = String(readFileSync(join(stateDir, "current"), "utf8")).trim();
    const snapFile = join(stateDir, key + ".snap");
    if (key && existsSync(snapFile) && worktreeSnap(root) === readFileSync(snapFile, "utf8").trim()) {
      process.exit(0);
    }
  } catch { /* no stamp file → verify conservatively */ }

  const res = spawnSync(process.execPath, [".keel/verify.mjs", "--fast"], { cwd: root, encoding: "utf8" });
  if (res.status === 0) process.exit(0);
  const tail = ((res.stdout ?? "") + (res.stderr ?? "")).trim().split("\n").slice(-15).join("\n");
  const reason = "keel verify failed — fix the failures before ending the turn:\n" + tail;
  process.stderr.write(reason + "\n");
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(2);
});
