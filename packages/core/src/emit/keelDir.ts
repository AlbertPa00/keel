import { CHECK_BOUNDARIES, CHECK_DRIFT, CHECK_PACKS, CHECK_STYLE, POST_COMPACTION, STOP_VERIFY, TURN_STAMP, VERIFY } from "./scripts.js";
import { invariantLines } from "./context.js";
import { resolveAliasMap } from "../graph.js";
import type { DesiredFile, EmitInput } from "./context.js";

/**
 * Resolve the verify command list:
 * explicit spec.autonomy.verify wins; otherwise the `verify` script if present,
 * else whichever of typecheck/lint/test exist in package.json scripts.
 */
export function resolveVerify(spec: EmitInput["spec"], scripts: string[], verifyCmds: string[] = []): { commands: string[]; warnings: string[] } {
  const pm = spec.stack.package_manager;
  if (spec.autonomy.verify) return { commands: [spec.autonomy.verify], warnings: [] };
  if (scripts.includes("verify")) return { commands: [`${pm} verify`], warnings: [] };
  const detected = ["typecheck", "lint", "test"].filter((s) => scripts.includes(s)).map((s) => `${pm} run ${s}`);
  if (detected.length) return { commands: detected, warnings: [] };
  if (verifyCmds.length) return { commands: verifyCmds, warnings: [] };
  return {
    commands: [],
    warnings: ["no verify command detected — set autonomy.verify in harness.yaml or verify will be a no-op"],
  };
}

export function emitKeelDir(input: EmitInput): { files: DesiredFile[]; warnings: string[] } {
  const { spec, fp, packs, dir } = input;
  const { commands, warnings } = resolveVerify(spec, fp?.scripts ?? [], fp?.verify_cmds ?? []);

  const hasLayers = spec.architecture.layers.length > 0;
  const aliases = hasLayers ? resolveAliasMap(dir) : {};
  const checks = packs
    .flatMap((p) => p.emits.checks.map((c) => ({ ...c, id: `${p.id}/${c.id}` })))
    .sort((a, b) => a.id.localeCompare(b.id));
  const harness = {
    version: 1,
    verify: commands,
    ...(spec.autonomy.verify_fast ? { verify_fast: [spec.autonomy.verify_fast] } : {}),
    verify_timeout_sec: spec.autonomy.verify_timeout_sec,
    boundaries: {
      layers: spec.architecture.layers,
      exceptions: spec.architecture.exceptions,
      ...(Object.keys(aliases).length ? { aliases } : {}),
    },
    style: {
      max_nesting: spec.style.max_nesting,
      max_function_lines: spec.style.max_function_lines,
      comments: spec.style.comments,
    },
    invariants: invariantLines(packs),
    ...(checks.length ? { checks } : {}),
  };

  const files: DesiredFile[] = [
    { path: ".keel/harness.json", content: `${JSON.stringify(harness, null, 2)}\n`, origin: "keel/manifest" },
    { path: ".keel/verify.mjs", content: VERIFY, origin: "keel/verify" },
    { path: ".keel/hooks/stop-verify.mjs", content: STOP_VERIFY, origin: "keel/hooks" },
    { path: ".keel/hooks/post-compaction.mjs", content: POST_COMPACTION, origin: "keel/hooks" },
    { path: ".keel/hooks/turn-stamp.mjs", content: TURN_STAMP, origin: "keel/hooks" },
    { path: ".keel/check-drift.mjs", content: CHECK_DRIFT, origin: "keel/drift" },
  ];
  if (hasLayers)
    files.push({ path: ".keel/check-boundaries.mjs", content: CHECK_BOUNDARIES, origin: "keel/boundaries" });
  if (checks.length)
    files.push({ path: ".keel/check-packs.mjs", content: CHECK_PACKS, origin: "keel/packs" });
  if (spec.style.max_nesting > 0 || spec.style.max_function_lines > 0)
    files.push({ path: ".keel/check-style.mjs", content: CHECK_STYLE, origin: "keel/style" });
  return { files, warnings };
}
