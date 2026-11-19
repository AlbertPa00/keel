#!/usr/bin/env node
// keel: offline drift check — every managed file in keel.lock.json must exist
// on disk and match its recorded SHA-256. Runs anywhere node exists; no keel
// install required (the CI gate alongside .keel/verify.mjs).
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "keel.lock.json");
if (!existsSync(lockPath)) {
  console.error("keel: keel.lock.json missing — run keel apply");
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const bad = [];
for (const e of lock.files ?? []) {
  const abs = join(root, e.path);
  if (!existsSync(abs)) { bad.push("missing:   " + e.path); continue; }
  const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
  if (sha !== e.sha256) bad.push("modified:  " + e.path);
}
if (bad.length) {
  console.error("keel: drift detected — generated files were edited or deleted; run keel apply:\n" + bad.map((b) => "  " + b).join("\n"));
  process.exit(1);
}
