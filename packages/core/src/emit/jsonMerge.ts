export interface PermissionSet {
  allow: string[];
  ask: string[];
  deny: string[];
}

export const EMPTY_PERMS: PermissionSet = { allow: [], ask: [], deny: [] };

/**
 * Union-merge permission entries into a settings object.
 * An entry already in a different list is moved to the target list (deny wins on cross-file conflicts —
 * we never weaken an existing deny; a new deny removes a user allow is intentional and reported upstream).
 */
export function mergePermissions(
  existing: Partial<PermissionSet> | undefined,
  add: PermissionSet,
): { merged: PermissionSet; added: PermissionSet; evicted: { allow: string[]; ask: string[] } } {
  const cur: PermissionSet = {
    allow: [...(existing?.allow ?? [])],
    ask: [...(existing?.ask ?? [])],
    deny: [...(existing?.deny ?? [])],
  };
  const added: PermissionSet = { allow: [], ask: [], deny: [] };
  const evicted: { allow: string[]; ask: string[] } = { allow: [], ask: [] };
  for (const key of ["allow", "ask", "deny"] as const) {
    for (const entry of add[key]) {
      const inAllow = cur.allow.includes(entry);
      const inAsk = cur.ask.includes(entry);
      const inDeny = cur.deny.includes(entry);
      if (key === "deny") {
        // deny wins: evict duplicates from weaker lists (recorded so remove() can restore them)
        if (inAllow) evicted.allow.push(entry);
        if (inAsk) evicted.ask.push(entry);
        cur.allow = cur.allow.filter((e) => e !== entry);
        cur.ask = cur.ask.filter((e) => e !== entry);
        if (!inDeny) {
          cur.deny.push(entry);
          added.deny.push(entry);
        }
      } else {
        if (inDeny) continue; // never weaken a deny
        const inTarget = key === "allow" ? inAllow : inAsk;
        const inOther = key === "allow" ? inAsk : inAllow;
        if (!inTarget && !inOther) {
          cur[key].push(entry);
          added[key].push(entry);
        }
      }
    }
  }
  return { merged: cur, added, evicted };
}

export function stripPermissions(
  existing: Partial<PermissionSet> | undefined,
  added: PermissionSet,
): PermissionSet {
  const rm = (list: string[], gone: string[]) => list.filter((e) => !gone.includes(e));
  return {
    allow: rm(existing?.allow ?? [], added.allow),
    ask: rm(existing?.ask ?? [], added.ask),
    deny: rm(existing?.deny ?? [], added.deny),
  };
}

interface HookEntry {
  matcher?: string;
  hooks: { type: string; command?: string }[];
}

/**
 * Merge keel hook entries into a hooks object.
 * Stale keel entries (command contains ".keel/" but not in desired set) are removed first,
 * then desired commands are appended if absent. Identified by command string.
 */
export function mergeHooks<T extends Record<string, HookEntry[]>>(
  existing: T | undefined,
  desired: T,
): { merged: T; added: string[] } {
  const merged = { ...(existing ?? {}) } as T;
  const desiredCmds = new Set<string>();
  for (const entries of Object.values(desired))
    for (const e of entries) for (const h of e.hooks) if (h.command) desiredCmds.add(h.command);

  for (const event of Object.keys(merged) as (keyof T)[]) {
    const kept = (merged[event] as HookEntry[]).filter(
      (e) => !e.hooks.some((h) => h.command?.includes(".keel/") && !desiredCmds.has(h.command)),
    );
    // An event emptied by keel-eviction held only keel commands → drop the key
    // rather than commit a "PostToolUse": [] wart (semantically identical).
    if (kept.length === 0) delete merged[event];
    else merged[event] = kept as T[keyof T];
  }

  const added: string[] = [];
  for (const [event, entries] of Object.entries(desired) as [keyof T, HookEntry[]][]) {
    const list = (merged[event] ?? []) as HookEntry[];
    const have = new Set(list.flatMap((e) => e.hooks.map((h) => h.command)));
    for (const e of entries) {
      const missing = e.hooks.filter((h) => h.command && !have.has(h.command));
      if (missing.length === 0) continue;
      list.push({ matcher: e.matcher ?? "", hooks: missing });
      for (const h of missing) if (h.command) added.push(h.command);
    }
    merged[event] = list as T[keyof T];
  }
  return { merged, added };
}

export function stripHooks<T extends Record<string, { hooks: { command?: string }[] }[]>>(
  existing: T | undefined,
  commands: string[],
): T {
  const merged = { ...(existing ?? {}) } as T;
  const gone = new Set(commands);
  for (const event of Object.keys(merged) as (keyof T)[]) {
    const kept = (merged[event] as { hooks: { command?: string }[] }[]).filter(
      (e) => !e.hooks.some((h) => h.command && gone.has(h.command)),
    );
    // Events emptied by stripping were keel-created → drop so restores stay clean.
    if (kept.length === 0) delete merged[event];
    else merged[event] = kept as T[keyof T];
  }
  return merged;
}
