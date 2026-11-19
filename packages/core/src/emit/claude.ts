import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mergeHooks, mergePermissions } from "./jsonMerge.js";
import type { PermissionSet } from "./jsonMerge.js";
import { priorUndo } from "./context.js";
import type { DesiredFile, EmitInput } from "./context.js";

/** Translate devin-native permission syntax to Claude Code settings.json syntax. */
export function toClaudePerm(entry: string): string[] {
  const scoped = /^(\w+)\((.*)\)$/.exec(entry);
  if (entry === "exec") return ["Bash"];
  if (!scoped) return [entry];
  const tool = scoped[1]!;
  const arg = scoped[2]!;
  switch (tool) {
    case "Exec":
      return [`Bash(${arg}:*)`];
    case "Read":
      return [entry];
    case "Write":
      return [`Write(${arg})`, `Edit(${arg})`];
    case "Fetch":
      return [`WebFetch(${arg})`];
    default:
      return [entry]; // mcp__* and unknown pass through
  }
}

function toClaudeSet(set: PermissionSet): PermissionSet {
  return {
    allow: set.allow.flatMap(toClaudePerm),
    ask: set.ask.flatMap(toClaudePerm),
    deny: set.deny.flatMap(toClaudePerm),
  };
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}

export function emitClaude(
  input: EmitInput,
  devinPerms: PermissionSet,
): { files: DesiredFile[]; warnings: string[]; errors: string[] } {
  const { spec, packs, read } = input;
  const files: DesiredFile[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];

  const path = ".claude/settings.json";
  const raw = read(path);
  let existing: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
      else errors.push(`${path}: expected a JSON object — fix or remove the file before apply`);
    } catch {
      errors.push(`${path}: invalid JSON — fix or remove the file before apply`);
    }
  }

  const permsExisted = existing["permissions"] !== undefined;
  const desired = toClaudeSet(devinPerms);
  const { merged, added, evicted } = mergePermissions(
    (existing["permissions"] as Partial<PermissionSet> | undefined) ?? {},
    desired,
  );

  // Evict stale keel-owned entries no longer desired; record the owned set for undo.
  const prevUndo = priorUndo(read, path);
  const owned: PermissionSet = { allow: [], ask: [], deny: [] };
  for (const k of ["allow", "ask", "deny"] as const) {
    const prev = prevUndo?.permissions_added?.[k] ?? [];
    const staleKeel = prev.filter((e) => !desired[k].includes(e));
    if (staleKeel.length) merged[k] = merged[k].filter((e) => !staleKeel.includes(e));
    owned[k] = [...new Set([...prev.filter((e) => desired[k].includes(e)), ...added[k]])];
  }

  const settingsOut: Record<string, unknown> = { ...existing, permissions: merged };

  // Claude Code hook events: PreToolUse, Stop, SessionStart, … (no PostCompact).
  const hooksExisted = existing["hooks"] !== undefined;
  const desiredHooks: Record<string, ClaudeHookEntry[]> = {};
  if (spec.autonomy.stop_hook && spec.autonomy.mode !== "guided") {
    desiredHooks["Stop"] = [
      { hooks: [{ type: "command", command: "node .keel/hooks/stop-verify.mjs", timeout: spec.autonomy.verify_timeout_sec + 30 }] },
    ];
    desiredHooks["UserPromptSubmit"] = [
      { matcher: "", hooks: [{ type: "command", command: "node .keel/hooks/turn-stamp.mjs" }] },
    ];
  }
  const { merged: mergedHooks, added: addedCmds } = mergeHooks(
    (existing["hooks"] as Record<string, ClaudeHookEntry[]> | undefined) ?? {},
    desiredHooks,
  );
  if (Object.keys(mergedHooks).length) settingsOut["hooks"] = mergedHooks;

  if (spec.autonomy.post_compaction)
    warnings.push("post_compaction invariant re-injection is devin-only; Claude target skips it (no PostCompact event)");

  files.push({
    path,
    content: `${JSON.stringify(settingsOut, null, 2)}\n`,
    origin: "claude/settings",
    undo: {
      permissions_added: owned,
      permissions_existed: permsExisted,
      hook_commands_added: addedCmds,
      hooks_existed: hooksExisted,
      ...(evicted.allow.length + evicted.ask.length > 0 ? { permissions_evicted: evicted } : {}),
    },
  });

  // Scoped rules — Claude Code reads .claude/rules/*.md with the same
  // trigger/glob frontmatter Devin uses; devin reads them back too via
  // read_config_from unless the duplicate-ingestion guard is set.
  for (const p of packs) {
    for (const rule of p.emits.rules) {
      const frontmatter = [
        "---",
        `description: "${p.name} (${p.id})"`,
        `trigger: ${rule.trigger}`,
        ...(rule.globs.length ? [`globs: ${JSON.stringify(rule.globs)}`] : []),
        "---",
        "",
      ].join("\n");
      files.push({
        path: `.claude/rules/${rule.file}`,
        content: `${frontmatter}${rule.body.trimEnd()}\n`,
        origin: `pack:${p.id}`,
      });
    }
  }

  for (const p of packs) {
    if (!p.emits.skill) continue;
    const name = p.id.split("/")[1]!;
    for (const rel of p.skill_files) {
      files.push({
        path: `.claude/skills/${name}/${rel.replace(/^skill\//, "")}`,
        content: readFileSync(join(p.dir, rel), "utf8"),
        origin: `pack:${p.id}`,
      });
    }
  }
  return { files, warnings, errors };
}
