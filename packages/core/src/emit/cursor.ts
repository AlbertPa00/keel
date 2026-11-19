import type { DesiredFile, EmitInput } from "./context.js";

/**
 * Cursor adapter — pack rules become .cursor/rules/*.mdc.
 * trigger mapping: always_on → alwaysApply:true; glob → globs + alwaysApply:false;
 * model_decision/manual → alwaysApply:false (description drives agent pickup).
 * No permissions/hooks API is managed — AGENTS.md carries the invariants.
 */
export function emitCursor(input: EmitInput): { files: DesiredFile[]; warnings: string[]; errors: string[] } {
  const { packs } = input;
  const files: DesiredFile[] = [];

  for (const p of packs) {
    for (const rule of p.emits.rules) {
      const frontmatter = [
        "---",
        `description: "${p.name} (${p.id})"`,
        ...(rule.trigger === "glob" && rule.globs.length ? [`globs: ${rule.globs.join(",")}`] : []),
        `alwaysApply: ${rule.trigger === "always_on" ? "true" : "false"}`,
        "---",
        "",
      ].join("\n");
      files.push({
        path: `.cursor/rules/keel-${rule.file.replace(/\.md$/, ".mdc")}`,
        content: `${frontmatter}${rule.body.trimEnd()}\n`,
        origin: `pack:${p.id}`,
      });
    }
  }
  return { files, warnings: [], errors: [] };
}
