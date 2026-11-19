#!/usr/bin/env node
// keel: verify gate — boundary check first, then the project's verify commands.
// --fast swaps the project command list for harness.verify_fast (Stop hook path).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const keelDir = dirname(fileURLToPath(import.meta.url));
const root = join(keelDir, "..");
const harness = JSON.parse(readFileSync(join(keelDir, "harness.json"), "utf8"));

const fast = process.argv.includes("--fast");
const projectCmds = fast ? (harness.verify_fast ?? harness.verify ?? []) : (harness.verify ?? []);

const steps = [];
if (existsSync(join(keelDir, "check-boundaries.mjs")) && (harness.boundaries?.layers ?? []).length)
  steps.push({ name: "boundaries", cmd: "node .keel/check-boundaries.mjs" });
if (existsSync(join(keelDir, "check-packs.mjs")) && (harness.checks ?? []).length)
  steps.push({ name: "packs", cmd: "node .keel/check-packs.mjs" });
if (existsSync(join(keelDir, "check-style.mjs")) && (harness.style?.max_nesting || harness.style?.max_function_lines))
  steps.push({ name: "style", cmd: "node .keel/check-style.mjs" });
for (const cmd of projectCmds) steps.push({ name: cmd, cmd });

let failed = false;
for (const step of steps) {
  const res = spawnSync(step.cmd, { cwd: root, shell: true, encoding: "utf8", timeout: (harness.verify_timeout_sec ?? 180) * 1000 });
  const out = ((res.stdout ?? "") + (res.stderr ?? "")).trim();
  if (res.status !== 0) {
    failed = true;
    const tail = out.split("\n").slice(-30).join("\n");
    console.error("keel verify FAIL [" + step.name + "]\n" + tail);
    break;
  }
}
process.exit(failed ? 1 : 0);
