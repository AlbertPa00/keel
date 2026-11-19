import { emitAgentsMd } from "./agentsMd.js";
import type { DesiredFile, EmitInput } from "./context.js";

/**
 * GitHub Copilot adapter — .github/copilot-instructions.md carries the managed
 * invariant block; pack rules become .github/instructions/keel-*.instructions.md
 * (applyTo = comma-joined globs, the all-files pattern when unscoped).
 */
export function emitCopilot(input: EmitInput): { files: DesiredFile[]; warnings: string[]; errors: string[] } {
  const { packs } = input;
  const files: DesiredFile[] = [];

  files.push(emitAgentsMd(input, ".github/copilot-instructions.md").file);

  for (const p of packs) {
    for (const rule of p.emits.rules) {
      const applyTo = rule.trigger === "glob" && rule.globs.length ? rule.globs.join(",") : "**/*";
      const frontmatter = [
        "---",
        `description: "${p.name} (${p.id})"`,
        `applyTo: "${applyTo}"`,
        "---",
        "",
      ].join("\n");
      files.push({
        path: `.github/instructions/keel-${rule.file.replace(/\.md$/, ".instructions.md")}`,
        content: `${frontmatter}${rule.body.trimEnd()}\n`,
        origin: `pack:${p.id}`,
      });
    }
  }
  return { files, warnings: [], errors: [] };
}
