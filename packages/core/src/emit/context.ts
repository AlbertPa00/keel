import type { Pack } from "../catalog/pack.js";
import type { Fingerprint } from "../fingerprint.js";
import type { MergeUndo } from "../plan/types.js";
import type { HarnessSpec } from "../spec/schema.js";

export interface EmitInput {
  spec: HarnessSpec;
  fp: Fingerprint | null;
  packs: Pack[];
  /** Absolute path of the target repo root — needed by emitters that resolve repo structure (aliases, workspaces). */
  dir: string;
  /** Read a project file (forward-slash rel path) or null if absent. */
  read: (rel: string) => string | null;
}

export interface DesiredFile {
  /** Forward-slash path relative to project root. */
  path: string;
  content: string;
  origin: string;
  managed_block?: boolean;
  /** Present when this file was merged into a pre-existing file. */
  undo?: MergeUndo;
}

/** Always-on lines contributed by packs, deduped, in selection order. */
export function invariantLines(packs: Pack[]): string[] {
  const seen = new Set<string>();
  for (const p of packs) for (const l of p.emits.agents_lines) seen.add(l.trim());
  return [...seen];
}

/** Per-layer import map: `adapters→domain+application, domain→∅` — honest for non-linear graphs. */
export function layerChain(spec: HarnessSpec): string {
  if (spec.architecture.layers.length === 0) return "";
  return spec.architecture.layers.map((l) => `${l.name}→${l.may_import.join("+") || "∅"}`).join(", ");
}

/**
 * Read the lockfile's undo journal for a given managed path — emitters use it to
 * evict keel-owned entries (permissions, rcf flags) that are no longer desired,
 * the same way mergeHooks evicts stale .keel/ hook commands.
 */
export function priorUndo(read: (rel: string) => string | null, path: string): MergeUndo | undefined {
  const raw = read("keel.lock.json");
  if (raw === null) return undefined;
  try {
    const lock = JSON.parse(raw) as { files?: { path: string; undo?: MergeUndo }[] };
    return lock.files?.find((f) => f.path === path)?.undo;
  } catch {
    return undefined;
  }
}
