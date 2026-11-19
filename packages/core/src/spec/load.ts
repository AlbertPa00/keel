import { parse, stringify } from "yaml";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { localSpecSchema, specSchema, tasteSchema } from "./schema.js";
import type { HarnessSpec, LocalSpec, TasteProfile } from "./schema.js";
import { readText } from "../util/fs.js";

export class SpecError extends Error {}

export function parseSpec(yamlText: string): HarnessSpec {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new SpecError(`Invalid YAML: ${(e as Error).message}`);
  }
  const res = specSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new SpecError(`Invalid harness spec:\n${issues}`);
  }
  return res.data;
}

export function specToYaml(spec: HarnessSpec): string {
  return stringify(spec);
}

export function loadSpecFile(path: string): HarnessSpec {
  const text = readText(path);
  if (text === null) throw new SpecError(`Spec file not found: ${path}`);
  return parseSpec(text);
}

/** User-level taste profile location — mirrors devin config conventions per platform. */
export function tastePath(): string {
  const base =
    platform() === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "devin")
      : join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "devin");
  return join(base, "taste.json");
}

export function loadTaste(path = tastePath()): TasteProfile {
  const text = readText(path);
  if (text === null) return {};
  const res = tasteSchema.safeParse(JSON.parse(text));
  if (!res.success) throw new SpecError(`Invalid taste profile at ${path}`);
  return res.data;
}

/** Fill fields the spec left at defaults from a partial taste object. Spec always wins. */
function fillDefaults<T extends Record<string, unknown>>(specObj: T, defObj: T, tasteObj: unknown): T {
  const out = { ...specObj };
  const taste = (tasteObj ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(defObj) as (keyof T)[]) {
    const v = taste[key as string];
    if (v !== undefined && JSON.stringify(out[key]) === JSON.stringify(defObj[key])) out[key] = v as T[keyof T];
  }
  return out;
}

/** Project spec wins over taste; taste only fills fields the spec left at defaults. */
export function mergeTaste(spec: HarnessSpec, taste: TasteProfile): HarnessSpec {
  const defaults = specSchema.parse({ version: 1 });
  return {
    ...spec,
    style: fillDefaults(spec.style, defaults.style, taste),
    safety: fillDefaults(spec.safety, defaults.safety, taste.safety),
    autonomy: fillDefaults(spec.autonomy, defaults.autonomy, taste.autonomy),
    budget: fillDefaults(spec.budget, defaults.budget, taste.budget),
  };
}

export function specExists(dir: string): boolean {
  return existsSync(join(dir, "harness.yaml")) || existsSync(join(dir, "harness.yml"));
}

export function specPath(dir: string): string {
  const yml = join(dir, "harness.yaml");
  return existsSync(yml) ? yml : join(dir, "harness.yml");
}

export function localSpecPath(dir: string): string | null {
  for (const name of ["harness.local.yaml", "harness.local.yml"]) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return null;
}

export function parseLocalSpec(yamlText: string, path: string): LocalSpec {
  let raw: unknown;
  try {
    raw = parse(yamlText);
  } catch (e) {
    throw new SpecError(`Invalid YAML in ${path}: ${(e as Error).message}`);
  }
  const res = localSpecSchema.safeParse(raw);
  if (!res.success) {
    const issues = res.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new SpecError(`Invalid ${path}:\n${issues}`);
  }
  return res.data;
}

/** Deep-merge personal overrides into the committed spec. Only fields present in local win. */
export function mergeLocalSpec(committed: HarnessSpec, local: LocalSpec): HarnessSpec {
  const pick = <T extends Record<string, unknown>>(
    base: T,
    over: { [K in keyof T]?: T[K] | undefined } | undefined,
  ): T => {
    if (!over) return base;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
      if (v !== undefined) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  };
  return {
    version: 1,
    project: pick(committed.project, local.project),
    targets: local.targets ?? committed.targets,
    stack: pick(committed.stack, local.stack),
    architecture: pick(committed.architecture, local.architecture),
    style: pick(committed.style, local.style),
    safety: pick(committed.safety, local.safety),
    autonomy: pick(committed.autonomy, local.autonomy),
    budget: pick(committed.budget, local.budget),
    packs: pick(committed.packs, local.packs),
  };
}

/**
 * Canonical spec loader: committed harness.yaml + personal harness.local.yaml.
 * Taste is intentionally NOT merged here — it only seeds `init`/drafts so that
 * plan/apply/check stay deterministic across machines and CI.
 */
export function loadSpec(dir: string): { spec: HarnessSpec; local_path: string | null } {
  const committedPath = specPath(dir);
  if (!existsSync(committedPath)) throw new SpecError(`no harness.yaml in ${dir} — run \`keel init\` first`);
  let spec = loadSpecFile(committedPath);
  const localPath = localSpecPath(dir);
  if (localPath) {
    const local = parseLocalSpec(readText(localPath)!, localPath.split(/[\\/]/).pop()!);
    spec = mergeLocalSpec(spec, local);
  }
  return { spec, local_path: localPath };
}
