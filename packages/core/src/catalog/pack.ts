import { z } from "zod";
import { parse } from "yaml";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { SLOTS } from "../spec/schema.js";
import { readText, sha256, walkFiles } from "../util/fs.js";

export const ENFORCEMENT = ["enforced", "checked", "advised"] as const;
export type Enforcement = (typeof ENFORCEMENT)[number];

export const ruleEmitsSchema = z.object({
  /** File name inside .devin/rules/ */
  file: z.string().regex(/^[\w.-]+\.md$/),
  trigger: z.enum(["always_on", "manual", "model_decision", "agent", "glob"]).default("model_decision"),
  globs: z.array(z.string()).default([]),
  body: z.string().min(1),
});

export const checkRuleSchema = z.object({
  /** Unique within the pack; reported as <pack.id>/<id>. */
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  kind: z.enum(["forbid_regex", "require_regex"]),
  /** File globs the check applies to. */
  globs: z.array(z.string()).min(1),
  exclude_globs: z.array(z.string()).default([]),
  pattern: z.string().min(1),
  flags: z.string().regex(/^[dgimsuvy]*$/).default(""),
  /** "code" = comments+strings masked; "text" = comments masked, strings kept; "raw" = bytes as-is. */
  scope: z.enum(["code", "text", "raw"]).default("code"),
  /** "error" fails the gate; "warn" reports without failing — hygiene findings stay visible. */
  severity: z.enum(["error", "warn"]).default("error"),
  message: z.string().min(1),
});

export const packSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*\/[a-z][a-z0-9_-]*$/, "id must be <slot>/<name>"),
  slot: z.enum(SLOTS),
  name: z.string().min(1),
  version: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().toLowerCase()).default([]),

  /** Framework keys this pack serves (spec.stack.frameworks / detected). */
  stack_keys: z.array(z.string().toLowerCase()).default([]),
  /** Principle keys this pack serves (spec.style.principles). */
  principle_keys: z.array(z.string().toLowerCase()).default([]),
  /** Major-version requirement: { react: "19" } means react major must equal 19 if known. */
  stack_version: z.record(z.string(), z.string()).default({}),

  paradigm: z.enum(["fp", "oop", "neutral"]).default("neutral"),
  conflicts_with: z.array(z.string()).default([]),
  token_cost: z.number().int().nonnegative().default(400),

  /** enforcement claims are verified by fixtures in CI; "advised" = prose only. */
  enforcement: z.enum(ENFORCEMENT).default("advised"),

  emits: z
    .object({
      /** Always-on lines for the AGENTS.md managed block. Keep ≤3 per pack. */
      agents_lines: z.array(z.string()).default([]),
      /** Scoped rule files (.devin/rules). */
      rules: z.array(ruleEmitsSchema).default([]),
      /** Extra permission entries (devin-native syntax; adapters translate). */
      permissions: z
        .object({
          allow: z.array(z.string()).default([]),
          ask: z.array(z.string()).default([]),
          deny: z.array(z.string()).default([]),
        })
        .default({}),
      /** Install the pack's skill/ directory into agent skill dirs. */
      skill: z.boolean().default(false),
      /** Mechanical checks compiled into .keel/check-packs.mjs (makes packs "checked"). */
      checks: z.array(checkRuleSchema).default([]),
    })
    .default({}),
});

export type PackManifest = z.infer<typeof packSchema>;

export interface Pack extends PackManifest {
  /** Absolute directory containing pack.yaml + optional skill/ + fixtures/. */
  dir: string;
  /** SHA-256 over pack.yaml + all bundled files (sorted paths + content). */
  hash: string;
  /** Files inside skill/ (relative paths), if emitted. */
  skill_files: string[];
  fixture_files: string[];
}

export class PackError extends Error {}

export function loadPack(dir: string): Pack {
  const manifestPath = join(dir, "pack.yaml");
  const text = readText(manifestPath);
  if (text === null) throw new PackError(`Missing pack.yaml in ${dir}`);
  const res = packSchema.safeParse(parse(text));
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new PackError(`Invalid pack at ${dir}:\n${issues}`);
  }
  const manifest = res.data;
  const expected = `${manifest.slot}/${dir.split(/[\\/]/).pop()}`;
  if (manifest.id !== expected)
    throw new PackError(`Pack id "${manifest.id}" does not match directory "${expected}"`);

  const files = walkFiles(dir);
  const hash = sha256(files.map((f) => `${f}\0${sha256(readText(join(dir, f)) ?? "")}`).join("\n"));
  const skillFiles = files.filter((f) => f.startsWith("skill/"));
  const fixtureFiles = files.filter((f) => f.startsWith("fixtures/"));

  if (manifest.emits.skill && skillFiles.length === 0)
    throw new PackError(`Pack ${manifest.id} declares emits.skill but has no skill/ files`);
  if (manifest.enforcement === "checked" && manifest.emits.checks.length === 0)
    throw new PackError(`Pack ${manifest.id}: enforcement "checked" requires emits.checks`);
  const emitsSomething =
    manifest.emits.skill || manifest.emits.agents_lines.length > 0 ||
    manifest.emits.rules.length > 0 || manifest.emits.checks.length > 0;
  if (manifest.enforcement !== "advised" && manifest.stack_keys.length > 0 && !emitsSomething)
    throw new PackError(`Pack ${manifest.id}: non-advised packs must emit something verifiable`);

  return { ...manifest, dir, hash, skill_files: skillFiles, fixture_files: fixtureFiles };
}

/** Load every pack under <root>/<slot>/<name>/. Returns map id → Pack. */
export function loadCatalog(root: string): Map<string, Pack> {
  const packs = new Map<string, Pack>();
  for (const slot of SLOTS) {
    const slotDir = join(root, slot);
    let entries;
    try {
      entries = readdirSync(slotDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pack = loadPack(join(slotDir, e.name));
      if (packs.has(pack.id)) throw new PackError(`Duplicate pack id: ${pack.id}`);
      packs.set(pack.id, pack);
    }
  }
  return packs;
}

/** Load roots in order; later roots override earlier packs by id (deterministic). */
export function loadCatalogOverlay(roots: string[]): { packs: Map<string, Pack>; overridden: string[] } {
  const packs = new Map<string, Pack>();
  const overridden = new Set<string>();
  for (const root of roots) {
    for (const [id, pack] of loadCatalog(root)) {
      if (packs.has(id)) overridden.add(id);
      packs.set(id, pack);
    }
  }
  return { packs, overridden: [...overridden].sort() };
}
