import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { readJson, readText } from "./util/fs.js";
import type { Target } from "./spec/schema.js";

export interface Fingerprint {
  language: string | null;
  package_manager: string | null;
  /** Detected framework/library keys with major versions when known. */
  frameworks: Record<string, string | null>;
  monorepo: boolean;
  workspaces: string[];
  test_runner: string | null;
  linter: string | null;
  tsconfig_strict: boolean | null;
  /** Agent config dirs already present. */
  agent_dirs: Target[];
  has_agents_md: boolean;
  scripts: string[];
  /** Detected verify commands for non-npm ecosystems (py/go/rust). */
  verify_cmds: string[];
}

const PM_LOCKFILES: Array<[string, string]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["bun.lockb", "bun"],
];

/** Dependency key → catalog framework key. Only exact, high-signal names. */
const DEP_TO_FRAMEWORK: Record<string, string> = {
  react: "react",
  next: "next",
  vue: "vue",
  svelte: "svelte",
  express: "express",
  fastify: "fastify",
  hono: "hono",
  koa: "koa",
  tailwindcss: "tailwindcss",
  prisma: "prisma",
  "@prisma/client": "prisma",
  drizzle: "drizzle",
  "drizzle-orm": "drizzle",
  vitest: "vitest",
  jest: "jest",
  playwright: "playwright",
  "@playwright/test": "playwright",
  zod: "zod",
  trpc: "trpc",
  "@trpc/server": "trpc",
  mongoose: "mongodb",
  stripe: "stripe",
};

/** go.mod require path → catalog framework key. */
const GO_DEP_TO_FRAMEWORK: Record<string, string> = {
  "github.com/gin-gonic/gin": "gin",
  "github.com/labstack/echo": "echo",
  "github.com/go-chi/chi": "chi",
  "github.com/gorilla/mux": "mux",
  "google.golang.org/grpc": "grpc",
  "github.com/spf13/cobra": "cobra",
  "github.com/stretchr/testify": "testify",
};

/** Cargo.toml dependency name → catalog framework key. */
const RS_DEP_TO_FRAMEWORK: Record<string, string> = {
  tokio: "tokio",
  serde: "serde",
  axum: "axum",
  "actix-web": "actix",
  clap: "clap",
  anyhow: "anyhow",
  thiserror: "thiserror",
  reqwest: "reqwest",
  tracing: "tracing",
};

/** pyproject/requirements dependency name → catalog framework key. */
const PY_DEP_TO_FRAMEWORK: Record<string, string> = {
  fastapi: "fastapi",
  django: "django",
  flask: "flask",
  sqlalchemy: "sqlalchemy",
  pydantic: "pydantic",
  pytest: "pytest",
  ruff: "ruff",
  mypy: "mypy",
  uvicorn: "uvicorn",
  celery: "celery",
  alembic: "alembic",
  httpx: "httpx",
  requests: "requests",
  starlette: "starlette",
  numpy: "numpy",
  pandas: "pandas",
};

function majorOf(range: string | undefined): string | null {
  if (!range) return null;
  const m = /\d+/.exec(range);
  return m ? m[0] : null;
}

function detectFromDeps(deps: Record<string, string> | undefined, out: Record<string, string | null>): void {
  for (const [dep, range] of Object.entries(deps ?? {})) {
    const key = DEP_TO_FRAMEWORK[dep];
    if (key) out[key] = majorOf(range);
  }
}

export function fingerprint(dir: string): Fingerprint {
  const fp: Fingerprint = {
    language: null,
    package_manager: null,
    frameworks: {},
    monorepo: false,
    workspaces: [],
    test_runner: null,
    linter: null,
    tsconfig_strict: null,
    agent_dirs: [],
    has_agents_md: existsSync(join(dir, "AGENTS.md")),
    scripts: [],
    verify_cmds: [],
  };

  const pkg = readJson<{
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    packageManager?: string;
    scripts?: Record<string, string>;
    workspaces?: string[] | { packages?: string[] };
  }>(join(dir, "package.json"));

  if (pkg) {
    fp.language = "typescript"; // JS/TS monorepos share the file; tsconfig refines below
    detectFromDeps(pkg.dependencies, fp.frameworks);
    detectFromDeps(pkg.devDependencies, fp.frameworks);
    fp.scripts = Object.keys(pkg.scripts ?? {});
    if (pkg.packageManager) fp.package_manager = pkg.packageManager.split("@")[0] ?? null;
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    if (ws?.length) {
      fp.monorepo = true;
      fp.workspaces = ws;
    }
  }

  for (const [lock, pm] of PM_LOCKFILES) {
    if (existsSync(join(dir, lock))) fp.package_manager ??= pm;
  }
  const pnpmWs = readText(join(dir, "pnpm-workspace.yaml"));
  if (pnpmWs !== null) {
    fp.monorepo = true;
    try {
      const parsed = parse(pnpmWs) as { packages?: string[] } | null;
      if (parsed?.packages?.length && fp.workspaces.length === 0) fp.workspaces = parsed.packages;
    } catch {
      // malformed workspace file — ignore
    }
  }

  // Recurse into workspace package.json files BEFORE deriving test runner /
  // tsconfig signals — in a monorepo the deps live in workspace packages.
  let anyWorkspaceTs = false;
  if (fp.monorepo) {
    for (const ws of fp.workspaces) {
      const base = ws.replace(/\/\*+$/, "");
      const abs = join(dir, base);
      if (!existsSync(abs)) continue;
      try {
        for (const sub of readdirSync(abs, { withFileTypes: true }).slice(0, 50)) {
          if (!sub.isDirectory()) continue;
          const subAbs = join(abs, sub.name);
          const subPkg = readJson<{
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          }>(join(subAbs, "package.json"));
          detectFromDeps(subPkg?.dependencies, fp.frameworks);
          detectFromDeps(subPkg?.devDependencies, fp.frameworks);
          if (existsSync(join(subAbs, "tsconfig.json")) || subPkg?.devDependencies?.["typescript"] || subPkg?.dependencies?.["typescript"]) {
            anyWorkspaceTs = true;
            // First workspace tsconfig found becomes the strictness sample when
            // the repo root has none (typical for turbo/pnpm workspaces).
            if (fp.tsconfig_strict === null) {
              const subTs = readJson<{ compilerOptions?: { strict?: boolean } }>(join(subAbs, "tsconfig.json"));
              if (subTs?.compilerOptions?.strict !== undefined) fp.tsconfig_strict = subTs.compilerOptions.strict;
            }
          }
        }
      } catch {
        // unreadable dir — ignore
      }
    }
  }

  const tsFile = ["tsconfig.json", "tsconfig.base.json"].find((f) => existsSync(join(dir, f)));
  const hasTsDep = Boolean(pkg?.devDependencies?.["typescript"] ?? pkg?.dependencies?.["typescript"]);
  if (tsFile) {
    const tsconfig = readJson<{ compilerOptions?: { strict?: boolean } }>(join(dir, tsFile));
    fp.tsconfig_strict = tsconfig?.compilerOptions?.strict ?? null;
  }
  if (!tsFile && !hasTsDep && !pkg && !anyWorkspaceTs) fp.language = null;
  if (pkg && !tsFile && !hasTsDep && !anyWorkspaceTs) fp.language = "javascript";
  if (anyWorkspaceTs && fp.language !== "rust" && fp.language !== "python") fp.language = "typescript";

  if (fp.frameworks["vitest"] !== undefined) fp.test_runner = "vitest";
  else if (fp.frameworks["jest"] !== undefined) fp.test_runner = "jest";
  if (existsSync(join(dir, "playwright.config.ts")) || existsSync(join(dir, "playwright.config.js")))
    fp.test_runner ??= "playwright";

  for (const name of ["eslint.config.mjs", "eslint.config.js", ".eslintrc.json", ".eslintrc.js", "biome.json"]) {
    if (existsSync(join(dir, name))) {
      fp.linter = name.startsWith("biome") ? "biome" : "eslint";
      break;
    }
  }

  if (existsSync(join(dir, ".devin"))) fp.agent_dirs.push("devin");
  if (existsSync(join(dir, ".claude"))) fp.agent_dirs.push("claude");
  if (existsSync(join(dir, ".cursor"))) fp.agent_dirs.push("cursor");
  if (existsSync(join(dir, ".windsurf"))) fp.agent_dirs.push("windsurf");
  if (existsSync(join(dir, ".github", "copilot-instructions.md")) || existsSync(join(dir, ".github", "instructions")))
    fp.agent_dirs.push("copilot");
  if (existsSync(join(dir, ".codex"))) fp.agent_dirs.push("codex");

  // Polyglot detection — go.mod, Cargo.toml, pyproject.toml/requirements.txt.
  // These only claim `language` when no package.json exists (a JS umbrella wins);
  // package_manager uses ??= so a stronger signal isn't clobbered.
  const gomod = readText(join(dir, "go.mod"));
  if (gomod !== null) {
    if (!pkg) fp.language = "go";
    fp.package_manager ??= "go";
    fp.verify_cmds.push("go vet ./...", "go test ./...");
    for (const m of gomod.matchAll(/^\s*([\w./~-]+)\s+v[\w.-]+/gm)) {
      const key = GO_DEP_TO_FRAMEWORK[m[1]!] ?? GO_DEP_TO_FRAMEWORK[m[1]!.replace(/\/v\d+$/, "")];
      if (key) fp.frameworks[key] = null;
    }
  }

  const cargo = readText(join(dir, "Cargo.toml"));
  if (cargo !== null) {
    if (!pkg) fp.language = "rust";
    fp.package_manager ??= "cargo";
    fp.verify_cmds.push("cargo clippy -- -D warnings", "cargo test");
    for (const [dep, key] of Object.entries(RS_DEP_TO_FRAMEWORK)) {
      if (new RegExp(`^${dep}\\s*=`, "m").test(cargo)) fp.frameworks[key] = null;
    }
  }

  const pyproj = readText(join(dir, "pyproject.toml"));
  const hasPy = pyproj !== null || existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "Pipfile"));
  if (hasPy) {
    if (!pkg) fp.language = "python";
    if (existsSync(join(dir, "uv.lock"))) fp.package_manager ??= "uv";
    else if (existsSync(join(dir, "poetry.lock"))) fp.package_manager ??= "poetry";
    else if (existsSync(join(dir, "Pipfile"))) fp.package_manager ??= "pipenv";
    else fp.package_manager ??= "pip";
    const pyText = `${pyproj ?? ""}\n${readText(join(dir, "requirements.txt")) ?? ""}`;
    for (const m of pyText.matchAll(/["'`]([a-zA-Z][\w-]*)/g)) {
      const key = PY_DEP_TO_FRAMEWORK[m[1]!.toLowerCase()];
      if (key) fp.frameworks[key] = null;
    }
    for (const m of pyText.matchAll(/^([a-zA-Z][\w-]*)\s*(?:[<>=!~[;]|$)/gm)) {
      const key = PY_DEP_TO_FRAMEWORK[m[1]!.toLowerCase()];
      if (key) fp.frameworks[key] ??= null;
    }
    if (fp.frameworks["pytest"] !== undefined) fp.test_runner ??= "pytest";
    if (fp.frameworks["ruff"] !== undefined || existsSync(join(dir, "ruff.toml"))) fp.linter ??= "ruff";
    if (fp.frameworks["mypy"] !== undefined || existsSync(join(dir, "mypy.ini"))) fp.linter ??= "mypy";
    const run =
      { uv: "uv run", poetry: "poetry run", pipenv: "pipenv run", pip: "" }[fp.package_manager ?? "pip"] ?? "";
    if (fp.frameworks["ruff"] !== undefined) fp.verify_cmds.push(`${run} ruff check .`.trim());
    if (fp.frameworks["mypy"] !== undefined) fp.verify_cmds.push(`${run} mypy .`.trim());
    if (fp.frameworks["pytest"] !== undefined) fp.verify_cmds.push(`${run} pytest`.trim());
  }

  return fp;
}
