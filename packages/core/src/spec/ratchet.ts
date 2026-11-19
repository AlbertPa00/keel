import type { BoundaryException } from "./schema.js";
import type { BoundaryViolation } from "../graph.js";

/**
 * Text surgery on harness.yaml: upsert the `exceptions:` block under
 * `architecture:` while preserving everything else (comments, ordering).
 * The block is managed wholesale — `keel ratchet` owns it.
 */

/** Group violations into exception entries: file → union of target layers. */
export function violationsToExceptions(violations: BoundaryViolation[], existing: BoundaryException[]): BoundaryException[] {
  const byFile = new Map<string, Set<string>>();
  for (const e of existing) {
    const set = byFile.get(e.file) ?? new Set<string>();
    for (const a of e.allow) set.add(a);
    byFile.set(e.file, set);
  }
  for (const v of violations) {
    const set = byFile.get(v.file) ?? new Set<string>();
    set.add(v.to_layer);
    byFile.set(v.file, set);
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, allow]) => ({ file, allow: [...allow].sort() }));
}

const quote = (s: string): string => (/[:#'"{}\[\],&*?|<>=!%@`\s]/.test(s) ? JSON.stringify(s) : s);

export function renderExceptions(entries: BoundaryException[]): string[] {
  const lines = ["  exceptions:"];
  for (const e of entries) {
    lines.push(`    - file: ${quote(e.file)}`);
    lines.push(`      allow: [${e.allow.join(", ")}]`);
  }
  return lines;
}

/** Insert or replace the `exceptions:` block under `architecture:`. */
export function upsertExceptionsYaml(yamlText: string, entries: BoundaryException[]): string {
  const lines = yamlText.replace(/\r\n/g, "\n").split("\n");
  // trim trailing blank lines for stable splicing; restore one at the end
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();

  const archIdx = lines.findIndex((l) => /^architecture\s*:/.test(l));
  const block = renderExceptions(entries);
  if (archIdx === -1) {
    return `${lines.join("\n")}\narchitecture:\n${block.join("\n")}\n`;
  }

  // architecture section ends at the next top-level key
  let end = lines.length;
  for (let i = archIdx + 1; i < lines.length; i++) {
    if (/\S/.test(lines[i]!) && !/^\s/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  // find an existing `exceptions:` sub-block inside the section
  let excStart = -1;
  let excEnd = -1;
  for (let i = archIdx + 1; i < end; i++) {
    if (/^\s+exceptions\s*:/.test(lines[i]!)) {
      excStart = i;
      excEnd = i + 1;
      while (excEnd < end && (/^\s{3,}\S/.test(lines[excEnd]!) || lines[excEnd]!.trim() === "")) excEnd++;
      break;
    }
  }

  if (excStart === -1) lines.splice(end, 0, ...block);
  else lines.splice(excStart, excEnd - excStart, ...block);
  return `${lines.join("\n")}\n`;
}
