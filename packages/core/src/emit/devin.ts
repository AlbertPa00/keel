import { join } from "node:path";
import { readFileSync } from "node:fs";
import { mergeHooks, mergePermissions, EMPTY_PERMS } from "./jsonMerge.js";
import type { PermissionSet } from "./jsonMerge.js";
import { priorUndo } from "./context.js";
import type { DesiredFile, EmitInput } from "./context.js";
import type { Pack } from "../catalog/pack.js";

/** Union of spec-driven + pack-contributed permission entries (devin syntax). Shared by both adapters. */
export function permUnion(packs: Pack[], spec: EmitInput["spec"]): PermissionSet {
  const out: PermissionSet = { allow: [], ask: [], deny: [] };
  for (const p of packs) {
    out.allow.push(...p.emits.permissions.allow);
    out.ask.push(...p.emits.permissions.ask);
    out.deny.push(...p.emits.permissions.deny);
  }
  // The verify command may be compound ("a && b") — each segment needs its own
  // permission entry, otherwise running one part alone still prompts.
  const verifyCmd = spec.autonomy.verify || "node .keel/verify.mjs";
  for (const seg of verifyCmd.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean)) out.allow.push(`Exec(${seg})`);
  if (spec.autonomy.verify_fast)
    for (const seg of spec.autonomy.verify_fast.split(/\s*(?:&&|\|\||;)\s*/).filter(Boolean))
      out.allow.push(`Exec(${seg})`);
  out.allow.push("Exec(node .keel/verify.mjs --fast)", "Exec(node .keel/check-drift.mjs)");
  out.allow.push(...spec.safety.extra_allow);
  out.ask.push(...spec.safety.extra_ask);
  out.deny.push(...spec.safety.extra_deny);
  out.ask.push(`Exec(${spec.stack.package_manager} add)`, `Exec(${spec.stack.package_manager} install)`);
  out.allow.push("Exec(git status)", "Exec(git diff)", "Exec(git log)");
  // keel's own MCP tools are read/plan-level; apply/remove write ops still confirm.
  out.allow.push("mcp__keel__*");
  if (spec.autonomy.mode === "strict-gated") {
    // every shell command not explicitly allowed above prompts
    out.ask.push("exec");
  } else {
    out.allow.push("Exec(git add)", "Exec(git commit)");
  }
  if (spec.safety.profile === "strict") {
    // publishing and history rewrites are denied outright, not prompted
    out.deny.push("Exec(git push)", "Exec(npm publish)", "Exec(pnpm publish)", "Exec(yarn publish)", "Write(*.pem)", "Write(*.key)");
    out.ask = out.ask.filter((e) => e !== "Exec(git push)");
  }
  for (const k of ["allow", "ask", "deny"] as const) out[k] = [...new Set(out[k])];
  return out;
}

interface HookDef {
  matcher?: string;
  hooks: { type: string; command: string; timeout?: number }[];
}
type HookMap = Record<string, HookDef[]>;

function parseJsonFile(path: string, text: string | null, errors: string[]): Record<string, unknown> {
  if (text === null || text.trim() === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      errors.push(`${path}: expected a JSON object — fix or remove the file before apply`);
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    errors.push(`${path}: invalid JSON — fix or remove the file before apply`);
    return {};
  }
}

export function emitDevin(input: EmitInput): { files: DesiredFile[]; errors: string[] } {
  const { spec, packs, read } = input;
  const files: DesiredFile[] = [];
  const errors: string[] = [];

  // --- .devin/config.json permissions -------------------------------------
  const configPath = ".devin/config.json";
  const existingConfig = parseJsonFile(configPath, read(configPath), errors);
  const permsExisted = existingConfig["permissions"] !== undefined;
  const desired = permUnion(packs, spec);
  const { merged, added, evicted } = mergePermissions(
    (existingConfig["permissions"] as Partial<PermissionSet> | undefined) ?? EMPTY_PERMS,
    desired,
  );

  // Evict stale keel-owned permission entries (added by a previous apply, no longer
  // desired) and compute the full keel-owned set for the undo journal.
  const prevUndo = priorUndo(read, configPath);
  const owned: PermissionSet = { allow: [], ask: [], deny: [] };
  for (const k of ["allow", "ask", "deny"] as const) {
    const prev = prevUndo?.permissions_added?.[k] ?? [];
    const staleKeel = prev.filter((e) => !desired[k].includes(e));
    if (staleKeel.length) merged[k] = merged[k].filter((e) => !staleKeel.includes(e));
    owned[k] = [...new Set([...prev.filter((e) => desired[k].includes(e)), ...added[k]])];
  }
  const configOut: Record<string, unknown> = { ...existingConfig, permissions: merged };

  // Duplicate-ingestion guard: when .claude/ is co-emitted, stop Devin re-importing
  // CLAUDE.md rules and .claude/skills (they'd be loaded twice every session).
  let rcfClaudeAdded = false;
  let rcfExisted = false;
  if (spec.targets.includes("claude")) {
    const rcf = (configOut["read_config_from"] ?? {}) as Record<string, unknown>;
    rcfExisted = existingConfig["read_config_from"] !== undefined;
    if (rcf["claude"] === undefined) {
      rcf["claude"] = false;
      rcfClaudeAdded = true;
    }
    configOut["read_config_from"] = rcf;
  }

  files.push({
    path: configPath,
    content: `${JSON.stringify(configOut, null, 2)}\n`,
    origin: "devin/permissions",
    undo: {
      permissions_added: owned,
      permissions_existed: permsExisted,
      ...(evicted.allow.length + evicted.ask.length > 0 ? { permissions_evicted: evicted } : {}),
      ...(rcfClaudeAdded ? { rcf_claude_added: true, rcf_existed: rcfExisted } : {}),
    },
  });

  // --- .devin/hooks.v1.json ------------------------------------------------
  const hookPath = ".devin/hooks.v1.json";
  const existingHooks = parseJsonFile(hookPath, read(hookPath), errors) as HookMap;
  const hooksExisted = Object.keys(existingHooks).length > 0;
  const desiredHooks: HookMap = {};
  if (spec.autonomy.stop_hook && spec.autonomy.mode !== "guided") {
    desiredHooks["Stop"] = [
      {
        matcher: "",
        hooks: [{ type: "command", command: "node .keel/hooks/stop-verify.mjs", timeout: spec.autonomy.verify_timeout_sec + 30 }],
      },
    ];
    // Turn stamping snapshots the worktree per prompt — the Stop gate compares
    // snapshots and only runs verify when the tree provably changed.
    desiredHooks["UserPromptSubmit"] = [
      { matcher: "", hooks: [{ type: "command", command: "node .keel/hooks/turn-stamp.mjs" }] },
    ];
  }
  if (spec.autonomy.post_compaction) {
    desiredHooks["PostCompaction"] = [
      { matcher: "", hooks: [{ type: "command", command: "node .keel/hooks/post-compaction.mjs" }] },
    ];
  }
  const { merged: mergedHooks, added: addedCmds } = mergeHooks(existingHooks, desiredHooks);
  files.push({
    path: hookPath,
    content: `${JSON.stringify(mergedHooks, null, 2)}\n`,
    origin: "devin/hooks",
    undo: { hook_commands_added: addedCmds, hooks_existed: hooksExisted },
  });

  // --- .devin/rules/*.md ----------------------------------------------------
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
        path: `.devin/rules/${rule.file}`,
        content: `${frontmatter}${rule.body.trimEnd()}\n`,
        origin: `pack:${p.id}`,
      });
    }
  }

  // --- .devin/skills/<id>/ --------------------------------------------------
  for (const p of packs) {
    if (!p.emits.skill) continue;
    const name = p.id.split("/")[1]!;
    for (const rel of p.skill_files) {
      const src = join(p.dir, rel);
      files.push({
        path: `.devin/skills/${name}/${rel.replace(/^skill\//, "")}`,
        content: readFileSync(src, "utf8"),
        origin: `pack:${p.id}`,
      });
    }
  }

  return { files, errors };
}
