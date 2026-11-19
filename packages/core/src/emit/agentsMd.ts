import { upsertManagedBlock } from "./managed.js";
import { invariantLines, layerChain } from "./context.js";
import type { DesiredFile, EmitInput } from "./context.js";

/**
 * The always-on contract. Deliberately terse — only non-standard requirements
 * and mechanically-enforced invariants belong here (no repo overview prose).
 */
export function emitAgentsMd(input: EmitInput, path: string): { file: DesiredFile; tokens: number } {
  const { spec, packs } = input;
  const lines: string[] = ["## Keel Harness — generated; edit `harness.yaml` then `keel apply`", ""];

  const fw = spec.stack.frameworks.length ? ` · ${spec.stack.frameworks.join(", ")}` : "";
  lines.push(`- Stack: ${spec.stack.language} · ${spec.stack.package_manager}${fw}`);

  const chain = layerChain(spec);
  if (chain) lines.push(`- Architecture: ${spec.architecture.style || "custom"} — \`${chain}\` (→ = may import)`);

  lines.push(`- Verify before finishing: \`${spec.autonomy.verify || "node .keel/verify.mjs"}\``);

  for (const l of invariantLines(packs)) {
    // the spec already prints its own "Architecture:" line above — don't repeat it
    if (chain && l.startsWith("Architecture:")) continue;
    lines.push(`- ${l}`);
  }

  if (spec.style.max_function_lines > 0 || spec.style.max_nesting > 0) {
    const parts = [
      spec.style.max_function_lines > 0 ? `functions ≤ ${spec.style.max_function_lines} lines` : "",
      spec.style.max_nesting > 0 ? `nesting ≤ ${spec.style.max_nesting}` : "",
    ].filter(Boolean);
    lines.push(`- Style gate: ${parts.join(", ")} — enforced by .keel/check-style.mjs`);
  }
  if (spec.style.comments === "minimal") lines.push("- Comments: minimal — name things, don't narrate");
  else if (spec.style.comments === "jsdoc-public") lines.push("- Comments: JSDoc on exported/public API only");

  const skills = packs.filter((p) => p.emits.skill).map((p) => p.id.split("/")[1]);
  if (skills.length) lines.push(`- Installed skills: ${skills.join(", ")} — invoke by name when the task matches`);

  const body = lines.join("\n");
  const existing = input.read(path);
  const { content } = upsertManagedBlock(existing, body);
  return {
    file: { path, content, origin: "agents-md", managed_block: true },
    tokens: Math.ceil(body.length / 4),
  };
}
