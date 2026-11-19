import type { Pack } from "../catalog/pack.js";
import type { Rejection } from "../resolve/resolve.js";
import type { Slot } from "../spec/schema.js";

/** A computed file change. All ops are full-content — merges are resolved at compile time. */
export interface FileOp {
  /** Forward-slash path relative to project root. */
  path: string;
  /** Final desired content; null = delete file. */
  content: string | null;
  /** Which emit produced it (e.g. "devin/permissions", "pack:stack/react-composition"). */
  origin: string;
  /** created | modified | unchanged | delete — computed by comparing to disk. */
  action: "create" | "modify" | "unchanged" | "delete";
  /** Managed markdown block (strip on remove). */
  managed_block?: boolean;
  /** Merge-reversal metadata recorded into the lockfile. */
  undo?: MergeUndo;
  /** Stale-restore op: writes restored content but must NOT be recorded in the new lockfile. */
  no_lock?: boolean;
}

export interface MergeUndo {
  /** Permission entries keel added (to strip on remove). */
  permissions_added?: { allow: string[]; ask: string[]; deny: string[] };
  /** User allow/ask entries a keel deny evicted (to re-add on remove). */
  permissions_evicted?: { allow: string[]; ask: string[] };
  /** Hook commands keel added (identified by command string). */
  hook_commands_added?: string[];
  /** Whether the permissions/hooks keys existed before keel touched the file. */
  permissions_existed?: boolean;
  hooks_existed?: boolean;
  /** read_config_from.claude=false was injected by keel (duplicate-ingestion guard). */
  rcf_claude_added?: boolean;
  /** Whether read_config_from existed before keel touched the file. */
  rcf_existed?: boolean;
}

export interface LockFile {
  version: 1;
  generated_at: string;
  catalog_hash: string;
  spec_hash: string;
  packs: { id: string; version: string; hash: string }[];
  files: LockFileEntry[];
}

export interface LockFileEntry {
  path: string;
  sha256: string;
  /** File did not exist before keel wrote it → delete on remove. */
  created: boolean;
  /** Managed markdown block — strip on remove. */
  managed_block: boolean;
  undo?: MergeUndo;
}

export interface HarnessPlan {
  ops: FileOp[];
  bySlot: Partial<Record<Slot, Pack[]>>;
  selected: Pack[];
  rejected: Rejection[];
  conflicts: Rejection[];
  warnings: string[];
  /** Hard failures — apply() refuses when non-empty. */
  errors: string[];
  /** Estimated always-on tokens in the AGENTS.md managed block. */
  always_on_tokens: number;
  always_on_budget: number;
  /** Count of constraints by enforcement level. */
  coverage: { enforced: number; checked: number; advised: number };
}
