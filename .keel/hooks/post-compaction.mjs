#!/usr/bin/env node
// keel: PostCompaction hook — re-inject the project's enforced invariants.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let event = "PostCompaction";
  try { event = JSON.parse(input || "{}").hook_event_name ?? event; } catch { /* ignore */ }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let invariants = [];
  try {
    invariants = JSON.parse(readFileSync(join(root, ".keel", "harness.json"), "utf8")).invariants ?? [];
  } catch { /* ignore */ }
  if (invariants.length === 0) process.exit(0);
  const ctx = "Active harness invariants (must hold for every change):\n" + invariants.map((l) => "- " + l).join("\n");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
  }));
});
