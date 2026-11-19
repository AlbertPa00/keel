import { stripManagedBlock } from "../emit/managed.js";
import { stripHooks, stripPermissions } from "../emit/jsonMerge.js";
import type { PermissionSet } from "../emit/jsonMerge.js";
import type { LockFileEntry } from "./types.js";

export interface Restore {
  /** rewrite = file survives with restored content; delete = file becomes empty/absent; keep = untouched user file. */
  action: "rewrite" | "delete" | "keep";
  content?: string;
}

/**
 * Compute the inverse-merge of a managed file — shared by compilePlan (stale-restore ops)
 * and remove() so both paths restore byte-identical user content.
 */
export function restoredContent(e: LockFileEntry, text: string): Restore {
  if (e.managed_block) {
    const stripped = stripManagedBlock(text);
    return stripped === null ? { action: "delete" } : { action: "rewrite", content: stripped };
  }

  let json: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { action: "keep" };
    json = parsed as Record<string, unknown>;
  } catch {
    return { action: "keep" };
  }

  let dirty = false;

  // read_config_from.claude duplicate-ingestion guard removal
  if (e.undo?.rcf_claude_added) {
    const rcf = json["read_config_from"] as Record<string, unknown> | undefined;
    if (rcf && typeof rcf === "object") {
      delete rcf["claude"];
      if (Object.keys(rcf).length === 0 && !e.undo.rcf_existed) delete json["read_config_from"];
      dirty = true;
    }
  }

  if (e.undo?.permissions_added) {
    const prev = (json["permissions"] ?? {}) as Partial<PermissionSet>;
    const perms = stripPermissions(prev, e.undo.permissions_added);
    if (e.undo.permissions_evicted) {
      for (const k of ["allow", "ask"] as const) {
        for (const entry of e.undo.permissions_evicted[k]) {
          if (!perms[k].includes(entry)) perms[k].push(entry);
        }
      }
    }
    const compact: Record<string, string[]> = {};
    for (const k of ["allow", "ask", "deny"] as const) {
      if (perms[k].length > 0 || (k in prev && (prev[k]?.length ?? 0) === 0)) compact[k] = perms[k];
    }
    if (Object.keys(compact).length === 0 && !e.undo.permissions_existed) delete json["permissions"];
    else json["permissions"] = compact;
    dirty = true;
  }

  if (e.undo?.hook_commands_added?.length) {
    if (e.path === ".devin/hooks.v1.json") {
      const stripped = stripHooks(json as Record<string, { hooks: { command?: string }[] }[]>, e.undo.hook_commands_added);
      if (Object.keys(stripped).every((k) => (stripped[k] ?? []).length === 0)) {
        return e.undo.hooks_existed
          ? { action: "rewrite", content: `${JSON.stringify(stripped, null, 2)}\n` }
          : { action: "delete" };
      }
      return { action: "rewrite", content: `${JSON.stringify(stripped, null, 2)}\n` };
    }
    const hooks = stripHooks(json["hooks"] as Record<string, { hooks: { command?: string }[] }[]> | undefined, e.undo.hook_commands_added);
    const empty = Object.keys(hooks).every((k) => (hooks[k] ?? []).length === 0);
    if (empty && !e.undo.hooks_existed) delete json["hooks"];
    else json["hooks"] = hooks;
    dirty = true;
  }

  return dirty ? { action: "rewrite", content: `${JSON.stringify(json, null, 2)}\n` } : { action: "keep" };
}
