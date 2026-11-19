import { join } from "node:path";
import { stringify } from "yaml";
import { readJson } from "../util/fs.js";
import { sha256 } from "../util/fs.js";
import type { LockFile, LockFileEntry } from "./types.js";
import type { HarnessSpec } from "../spec/schema.js";
import type { Pack } from "../catalog/pack.js";

export const LOCKFILE_NAME = "keel.lock.json";

/** Stable hash over the normalized spec — same spec bytes → same plan inputs. */
export function specHash(spec: HarnessSpec): string {
  return sha256(stringify(spec));
}

export function catalogHash(packs: Pack[]): string {
  return sha256(
    packs
      .map((p) => `${p.id}@${p.version}:${p.hash}`)
      .sort()
      .join("\n"),
  );
}

export function readLockfile(dir: string): LockFile | null {
  return readJson<LockFile>(join(dir, LOCKFILE_NAME));
}

export function lockfileContent(packs: Pack[], spec: HarnessSpec, files: LockFileEntry[]): string {
  const lock: LockFile = {
    version: 1,
    generated_at: new Date().toISOString(),
    catalog_hash: catalogHash(packs),
    spec_hash: specHash(spec),
    packs: packs.map((p) => ({ id: p.id, version: p.version, hash: p.hash })),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  return `${JSON.stringify(lock, null, 2)}\n`;
}
