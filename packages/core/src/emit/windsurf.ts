import type { DesiredFile, EmitInput } from "./context.js";

/**
 * Windsurf adapter — .windsurf/rules/*.md uses the same trigger/glob frontmatter
 * vocabulary as Devin rules (always_on | manual | model_decision | glob), so
 * pack rules translate 1:1. No permissions/hooks API is managed.
 */
export function emitWindsurf(input: EmitInput): { files: DesiredFile[]; warnings: string[]; errors: string[] } {
  const { packs } = input;
  const files: DesiredFile[] = [];

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
        path: `.windsurf/rules/keel-${rule.file}`,
        content: `${frontmatter}${rule.body.trimEnd()}\n`,
        origin: `pack:${p.id}`,
      });
    }
  }
  return { files, warnings: [], errors: [] };
}
