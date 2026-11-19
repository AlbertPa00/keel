import { specSchema } from "./schema.js";
import type { HarnessSpec } from "./schema.js";
import type { Fingerprint } from "../fingerprint.js";

export interface DraftField {
  path: string;
  value: unknown;
  source: "detected" | "default" | "stated";
}

export interface DraftResult {
  spec: HarnessSpec;
  fields: DraftField[];
  conflicts: string[];
  questions: string[];
}

const ARCH_KEYWORDS: Record<string, string> = {
  hexagonal: "hexagonal",
  "ports and adapters": "hexagonal",
  layered: "layered",
  "atomic design": "atomic-design",
};
const PRINCIPLE_KEYWORDS = ["solid", "atomic-design", "tdd", "dry", "clean-architecture"];

/**
 * Build a draft spec from a repo fingerprint (+ optional free intent).
 * Detected values are marked; everything else is an explicit default so the
 * human reviews a complete document, not a guess.
 */
export function draftSpec(fp: Fingerprint, intent = ""): DraftResult {
  const fields: DraftField[] = [];
  const conflicts: string[] = [];
  const questions: string[] = [];
  const low = intent.toLowerCase();

  const spec = specSchema.parse({ version: 1 });
  spec.project.intent = intent;

  if (fp.language) {
    spec.stack.language = fp.language;
    fields.push({ path: "stack.language", value: fp.language, source: "detected" });
  }
  if (fp.package_manager) {
    spec.stack.package_manager = fp.package_manager;
    fields.push({ path: "stack.package_manager", value: fp.package_manager, source: "detected" });
  }
  for (const pm of ["pnpm", "npm", "yarn", "bun"] as const) {
    if (new RegExp(`\\b${pm}\\b`).test(low) && fp.package_manager && fp.package_manager !== pm) {
      conflicts.push(`Intent mentions ${pm}, but repository uses ${fp.package_manager}.`);
    }
  }
  for (const runner of ["vitest", "jest"] as const) {
    if (new RegExp(`\\b${runner}\\b`).test(low) && fp.test_runner && fp.test_runner !== runner) {
      conflicts.push(`Intent mentions ${runner}, but repository uses ${fp.test_runner}.`);
    }
  }

  const fw = Object.keys(fp.frameworks).sort();
  if (fw.length) {
    spec.stack.frameworks = fw;
    fields.push({ path: "stack.frameworks", value: fw, source: "detected" });
  }
  if (fp.agent_dirs.length) {
    spec.targets = fp.agent_dirs;
    fields.push({ path: "targets", value: fp.agent_dirs, source: "detected" });
  }
  if (fp.scripts.includes("verify")) {
    spec.autonomy.verify = `${spec.stack.package_manager} verify`;
    fields.push({ path: "autonomy.verify", value: spec.autonomy.verify, source: "detected" });
  } else if (fp.verify_cmds.length) {
    spec.autonomy.verify = fp.verify_cmds.join(" && ");
    fields.push({ path: "autonomy.verify", value: spec.autonomy.verify, source: "detected" });
  }

  for (const [needle, arch] of Object.entries(ARCH_KEYWORDS)) {
    if (low.includes(needle)) {
      spec.architecture.style = arch;
      fields.push({ path: "architecture.style", value: arch, source: "stated" });
      break;
    }
  }
  if (/\bfp\b|\bfunctional\b/.test(low)) {
    spec.style.paradigm = "fp";
    fields.push({ path: "style.paradigm", value: "fp", source: "stated" });
  } else if (/\boop\b|\bobject[- ]oriented\b/.test(low)) {
    spec.style.paradigm = "oop";
    fields.push({ path: "style.paradigm", value: "oop", source: "stated" });
  }
  const statedPrinciples = PRINCIPLE_KEYWORDS.filter((k) => low.includes(k.replace("-", " ")) || low.includes(k));
  if (statedPrinciples.length) {
    spec.style.principles = statedPrinciples;
    fields.push({ path: "style.principles", value: statedPrinciples, source: "stated" });
  }

  if (fp.language && fp.language !== "typescript" && fp.language !== "javascript")
    questions.push(`Detected ${fp.language}: no packs cover this stack yet — harness will emit permissions/hooks only.`);
  if (!fp.package_manager && fp.language)
    questions.push("No package manager detected — spec defaults to pnpm; edit stack.package_manager if wrong.");
  if (spec.stack.frameworks.length === 0 && fp.language)
    questions.push("No frameworks detected — add stack.frameworks keys (e.g. react, express, prisma) for stack packs.");
  questions.push("Declare architecture.layers for mechanical boundary enforcement, and style.principles for style packs.");

  return { spec, fields, conflicts, questions };
}
