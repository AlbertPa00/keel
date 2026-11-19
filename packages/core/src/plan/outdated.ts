import { compilePlan } from "./compile.js";
import { readLockfile } from "./lockfile.js";
import type { CompileOptions } from "./compile.js";
import type { HarnessSpec } from "../spec/schema.js";

/**
 * `keel outdated` — which selected packs diverge from what keel.lock.json
 * recorded at last apply. `keel check` only reports drift happened; this
 * names it: catalog version bump, in-place content edit, pack added to or
 * dropped from the spec's selection.
 */

export interface PackDriftEntry {
  id: string;
  kind: "version" | "content" | "added" | "removed";
  locked: string;
  current: string;
}

export interface OutdatedReport {
  lock_missing: boolean;
  entries: PackDriftEntry[];
}

export function outdated(dir: string, spec: HarnessSpec, opts: CompileOptions = {}): OutdatedReport {
  const lock = readLockfile(dir);
  if (!lock) return { lock_missing: true, entries: [] };
  const plan = compilePlan(dir, spec, opts);
  const locked = new Map(lock.packs.map((p) => [p.id, p]));
  const current = new Map(plan.selected.map((p) => [p.id, p]));
  const entries: PackDriftEntry[] = [];
  for (const [id, cur] of [...current.entries()].sort()) {
    const prev = locked.get(id);
    if (!prev) entries.push({ id, kind: "added", locked: "-", current: cur.version });
    else if (prev.version !== cur.version)
      entries.push({ id, kind: "version", locked: prev.version, current: cur.version });
    else if (prev.hash !== cur.hash)
      entries.push({ id, kind: "content", locked: prev.hash.slice(0, 12), current: cur.hash.slice(0, 12) });
  }
  for (const [id, prev] of [...locked.entries()].sort()) {
    if (!current.has(id)) entries.push({ id, kind: "removed", locked: prev.version, current: "-" });
  }
  return { lock_missing: false, entries };
}
