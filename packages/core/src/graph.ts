import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { matchesGlob } from "./util/glob.js";
import { maskSource } from "./util/mask.js";
import { readJson, readText, walkFiles } from "./util/fs.js";
import type { BoundaryException, Layer } from "./spec/schema.js";

/**
 * The deterministic import graph — twin of .keel/check-boundaries.mjs.
 * Powers `keel graph` (reporting) and `keel ratchet` (baseline generation).
 */

export interface ImportEdge {
  /** Repo-relative file containing the import. */
  from: string;
  /** Raw specifier as written. */
  spec: string;
  /** Resolved repo-relative target (extensionless), or null for external/alias-free. */
  to: string | null;
  line: number;
}

export interface BoundaryViolation {
  file: string;
  line: number;
  from_layer: string;
  to_layer: string;
  spec: string;
}

const IGNORE = /^(node_modules|dist|coverage|\.git|\.keel|\.devin|\.claude|\.cursor|\.windsurf|\.codex)\//;

const mask = maskSource;

/** Workspace package name → package dir (e.g. "trackforge-mcp" → "apps/mcp"). */
function workspaceNameMap(dir: string): Map<string, string> {
  const roots = new Set<string>();
  const pkg = readJson<{ workspaces?: string[] | { packages?: string[] } }>(join(dir, "package.json"));
  const ws = Array.isArray(pkg?.workspaces) ? pkg?.workspaces : pkg?.workspaces?.packages;
  for (const w of ws ?? []) roots.add(w.replace(/\/\*+$/, ""));
  const pnpmWs = readText(join(dir, "pnpm-workspace.yaml"));
  if (pnpmWs !== null) {
    try {
      for (const w of (parse(pnpmWs) as { packages?: string[] } | null)?.packages ?? []) {
        roots.add(w.replace(/\/\*+$/, ""));
      }
    } catch {
      // malformed workspace file — ignore
    }
  }
  const map = new Map<string, string>();
  for (const base of roots) {
    const abs = join(dir, base);
    if (!existsSync(abs)) continue;
    for (const sub of readdirSync(abs, { withFileTypes: true }).slice(0, 100)) {
      if (!sub.isDirectory()) continue;
      const name = readJson<{ name?: string }>(join(abs, sub.name, "package.json"))?.name;
      if (name) map.set(name, `${base}/${sub.name}`.replace(/\\/g, "/"));
    }
  }
  return map;
}

const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
const KEYWORD_RE = /^(?:from|import|require)/;
// Python: `import a.b` / `from a.b import x` / `from ..a import x`
const PY_IMPORT_RE = /\b(from\s+([.\w]+)\s+import|import\s+([\w.]+))/g;
const PY_KEYWORD_RE = /^(from|import)/;
// Go: `import "x"` (optionally named) and `import ( "a" \n "b" )`
const GO_BLOCK_RE = /\bimport\s*\(\s*((?:\s*[\w.]*\s*"[^"]+"\s*)+)\)/g;
const GO_ONE_RE = /\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g;
const GO_STR_RE = /"([^"]+)"/g;
// Rust: `use a::b::{..}` / `pub use crate::x` — line-anchored on purpose.
const RS_USE_RE = /^\s*(?:pub\s+)?use\s+([A-Za-z_][\w:]*)/gm;

/** tsconfig compilerOptions.paths + baseUrl → alias entries (key may contain one "*"). */
function tsconfigAliases(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["tsconfig.json", "tsconfig.base.json"]) {
    const cfg = readJson<{ compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } }>(
      join(dir, name),
    );
    const co = cfg?.compilerOptions;
    if (!co?.paths) continue;
    const base = (co.baseUrl ?? ".").replace(/^\.\//, "").replace(/\/$/, "");
    for (const [key, values] of Object.entries(co.paths)) {
      const v = values[0];
      if (v === undefined) continue;
      const rel = v.replace(/^\.\//, "").replace(/\/$/, "");
      out[key] = base && base !== "." ? `${base}/${rel}` : rel;
    }
    break; // first tsconfig wins
  }
  return out;
}

/**
 * Repo import alias map — merges (lowest → highest precedence):
 * conventional @/ + ~/ → src/, workspace package names → <pkg>/src,
 * tsconfig compilerOptions.paths. Baked into .keel/harness.json so the
 * emitted boundary checker resolves specifiers exactly like this graph.
 */
export function resolveAliasMap(dir: string): Record<string, string> {
  const out: Record<string, string> = { "@/*": "src/*", "~/*": "src/*" };
  for (const [name, pkgDir] of workspaceNameMap(dir)) out[name] = `${pkgDir}/src`;
  for (const [k, v] of Object.entries(tsconfigAliases(dir))) out[k] = v;
  const goMod = readText(join(dir, "go.mod"))?.match(/^module\s+(\S+)/m)?.[1];
  if (goMod && out[goMod] === undefined) out[goMod] = "";
  for (const [name, srcDir] of cargoCrateMap(dir)) if (out[name] === undefined) out[name] = srcDir;
  return out;
}

/** Cargo workspace member name → <member>/src (from root Cargo.toml [workspace]). */
function cargoCrateMap(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = readText(join(dir, "Cargo.toml"));
  if (root === null) return out;
  const ws = root.match(/\[workspace\]([\s\S]*?)(?=\n\s*\[|$)/)?.[1] ?? "";
  for (const m of ws.matchAll(/"([^"]+)"/g)) {
    const memberGlob = m[1]!;
    const base = memberGlob.replace(/\/\*+$/, "");
    const subs = memberGlob.endsWith("/*")
      ? (existsSync(join(dir, base)) ? readdirSync(join(dir, base), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => `${base}/${e.name}`) : [])
      : [memberGlob];
    for (const member of subs) {
      const name = readText(join(dir, member, "Cargo.toml"))?.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)?.[1];
      if (name) out.set(name, `${member}/src`);
    }
  }
  const rootName = root.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/)?.[1];
  if (rootName) out.set(rootName, "src");
  return out;
}

/** Nearest ancestor dir (repo-relative) containing Cargo.toml — the crate root. */
export function crateRootOf(dir: string, rel: string): string {
  let d = dirname(rel);
  for (;;) {
    if (existsSync(join(dir, d === "." ? "Cargo.toml" : `${d}/Cargo.toml`))) return d === "." ? "" : d;
    if (d === "." || d === "") return "";
    d = dirname(d);
  }
}

/**
 * Resolve a specifier against an alias map — identical semantics to the
 * resolver embedded in .keel/check-boundaries.mjs. Returns repo-relative
 * path or null when no alias matches and the specifier isn't relative.
 */
export function resolveAliasSpec(spec: string, aliases: Record<string, string>): string | null {
  let best: { key: string; value: string } | null = null;
  for (const [key, value] of Object.entries(aliases)) {
    const star = key.indexOf("*");
    if (star === -1) {
      if (spec !== key && !spec.startsWith(`${key}/`)) continue;
    } else {
      const pre = key.slice(0, star);
      const suf = key.slice(star + 1);
      if (!spec.startsWith(pre) || !spec.endsWith(suf) || spec.length < pre.length + suf.length) continue;
    }
    if (best === null || key.length > best.key.length) best = { key, value };
  }
  if (best === null) return null;
  const star = best.key.indexOf("*");
  if (star === -1) {
    const rest = spec.slice(best.key.length).replace(/^\//, "");
    // An empty alias value means "strip the prefix" (e.g. a go module path).
    return rest ? (best.value ? `${best.value}/${rest}` : rest) : best.value || null;
  }
  const mid = spec.slice(best.key.slice(0, star).length, spec.length - best.key.slice(star + 1).length);
  return best.value.replace("*", mid);
}

/** Resolve an import specifier to a repo-relative path, or null (external/pkg). */
function resolveSpec(spec: string, fromRel: string, aliases: Record<string, string>): string | null {
  if (spec.startsWith(".")) {
    return join(dirname(fromRel), spec).split("\\").join("/");
  }
  return resolveAliasSpec(spec, aliases);
}

/** Python: `a.b.c` → a/b/c; `from .x`/`from ..x` resolve against the file's package. */
function resolvePy(spec: string, fromRel: string): string | null {
  const dots = spec.match(/^\.*/)![0].length;
  if (dots === 0) return spec.replace(/\./g, "/");
  let base = dirname(fromRel);
  for (let k = 1; k < dots; k++) base = dirname(base);
  const rest = spec.slice(dots).replace(/\./g, "/");
  const rel = rest ? (base === "." ? rest : `${base}/${rest}`) : base === "." ? "" : base;
  return rel === "" ? null : rel;
}

/** Rust: crate::/self::/super:: are path-relative; other specs hit crate aliases. */
function resolveRs(spec: string, fromRel: string, dir: string, aliases: Record<string, string>): string | null {
  if (spec.startsWith("crate::")) {
    const crateRoot = crateRootOf(dir, fromRel);
    const rest = spec.slice(7).replace(/::/g, "/");
    return `${crateRoot ? `${crateRoot}/` : ""}src/${rest}`;
  }
  if (spec.startsWith("self::"))
    return join(dirname(fromRel), spec.slice(6).replace(/::/g, "/")).split("\\").join("/");
  let s = spec;
  let ups = 0;
  while (s.startsWith("super::")) {
    ups++;
    s = s.slice(7);
  }
  if (ups > 0) {
    let base = dirname(fromRel);
    for (let k = 0; k < ups; k++) base = dirname(base);
    const rest = s.replace(/::/g, "/");
    return base === "." ? rest : `${base}/${rest}`;
  }
  return resolveAliasSpec(s.replace(/::/g, "/"), aliases);
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs)$/;
const stripExt = (p: string): string => p.replace(/\.(js|ts|jsx|tsx|mts|cts|mjs|cjs|py|go|rs)$/, "");

/** Raw import hits per file — keyword-verified against the deep mask. */
function rawImports(rel: string, text: string, deep: string): { spec: string; index: number }[] {
  const out: { spec: string; index: number }[] = [];
  const kwVisible = (index: number, re: RegExp) => re.test(deep.slice(index, index + 8));
  if (rel.endsWith(".py")) {
    for (const m of text.matchAll(PY_IMPORT_RE)) {
      if (!kwVisible(m.index, PY_KEYWORD_RE)) continue;
      out.push({ spec: (m[2] ?? m[3])!, index: m.index });
    }
    return out;
  }
  if (rel.endsWith(".go")) {
    for (const m of text.matchAll(GO_BLOCK_RE)) {
      if (!kwVisible(m.index, /^import/)) continue;
      for (const s of m[0].matchAll(GO_STR_RE)) out.push({ spec: s[1]!, index: m.index + s.index });
    }
    for (const m of text.matchAll(GO_ONE_RE)) {
      if (!kwVisible(m.index, /^import/)) continue;
      out.push({ spec: m[1]!, index: m.index });
    }
    return out;
  }
  if (rel.endsWith(".rs")) {
    for (const m of text.matchAll(RS_USE_RE)) {
      const useIdx = m.index + m[0].search(/use\s/);
      if (!kwVisible(useIdx, /^use/)) continue;
      out.push({ spec: m[1]!, index: m.index });
    }
    return out;
  }
  for (const m of text.matchAll(IMPORT_RE)) {
    if (!KEYWORD_RE.test(deep.slice(m.index, m.index + 7))) continue;
    out.push({ spec: m[1]!, index: m.index });
  }
  return out;
}

const resolveImport = (spec: string, fromRel: string, dir: string, aliases: Record<string, string>): string | null => {
  if (fromRel.endsWith(".py")) return resolvePy(spec, fromRel);
  if (fromRel.endsWith(".rs")) return resolveRs(spec, fromRel, dir, aliases);
  return resolveSpec(spec, fromRel, aliases);
};

const CANDIDATE_SUFFIXES = [".ts", ".tsx", ".js", ".py", ".go", ".rs", "/index.ts", "/index.tsx", "/index.js", "/__init__.py", "/mod.rs", "/x"];
/** Bases a resolved import may live at — python src-layout adds a src/ twin. */
const candidateBases = (base: string, fromRel: string): string[] =>
  fromRel.endsWith(".py") ? [base, `src/${base}`] : [base];

/** Every import edge in the repo (comment- and string-aware), forward-slash paths. */
export function importGraph(dir: string): ImportEdge[] {
  const aliases = resolveAliasMap(dir);
  const files = walkFiles(dir, [IGNORE]).filter((f) => SOURCE_RE.test(f));
  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  for (const rel of files) {
    const raw = readText(join(dir, rel));
    if (raw === null) continue;
    const lang = rel.endsWith(".py") ? "py" : "c";
    const text = mask(raw, false, lang);
    const deep = mask(raw, true, lang);
    for (const { spec, index } of rawImports(rel, text, deep)) {
      const resolved = resolveImport(spec, rel, dir, aliases);
      if (resolved === null) continue;
      const base = stripExt(resolved);
      // Match the emitted checker's candidate list so both engines agree.
      const candidates = candidateBases(base, rel).flatMap((b) => [b, ...CANDIDATE_SUFFIXES.map((s) => b + s)]);
      const to = candidates.find((c) => fileSet.has(c)) ?? base;
      edges.push({
        from: rel,
        spec,
        to: stripExt(to),
        line: text.slice(0, index).split("\n").length,
      });
    }
  }
  return edges;
}

/** Most-specific layer matching a repo-relative path (same semantics as the checker). */
export function layerOf(rel: string, layers: Layer[]): Layer | null {
  let best: Layer | null = null;
  let score = -1;
  for (const l of layers) {
    for (const g of l.paths) {
      if (!matchesGlob(rel, g)) continue;
      const head = g.split("*")[0]!.length;
      if (head > score) {
        score = head;
        best = l;
      }
    }
  }
  return best;
}

/** Violating edges after layer rules + per-file exceptions (the ratchet baseline). */
export function boundaryViolations(dir: string, layers: Layer[], exceptions: BoundaryException[]): BoundaryViolation[] {
  const out: BoundaryViolation[] = [];
  for (const edge of importGraph(dir)) {
    const src = layerOf(edge.from, layers);
    if (!src || !edge.to) continue;
    const target = layerOfCandidates(edge.to, layers);
    if (!target || target.name === src.name) continue;
    if (src.may_import.includes(target.name)) continue;
    const excepted = exceptions.some((e) => matchesGlob(edge.from, e.file) && e.allow.includes(target.name));
    if (excepted) continue;
    out.push({ file: edge.from, line: edge.line, from_layer: src.name, to_layer: target.name, spec: edge.spec });
  }
  return out;
}

const layerOfCandidates = (rel: string, layers: Layer[]): Layer | null => {
  for (const c of [rel, ...CANDIDATE_SUFFIXES.map((s) => rel + s)]) {
    const l = layerOf(c, layers);
    if (l) return l;
  }
  return null;
};

/**
 * Exception entries that quarantine nothing — every violating import they allow
 * is already fixed, so the debt is paid and the entry must be removed.
 * Twin of the stale-ratchet check inside .keel/check-boundaries.mjs.
 */
export function staleExceptions(dir: string, layers: Layer[], exceptions: BoundaryException[]): BoundaryException[] {
  const used = new Set<BoundaryException>();
  for (const edge of importGraph(dir)) {
    const src = layerOf(edge.from, layers);
    if (!src || !edge.to) continue;
    const target = layerOfCandidates(edge.to, layers);
    if (!target || target.name === src.name || src.may_import.includes(target.name)) continue;
    for (const e of exceptions) {
      if (matchesGlob(edge.from, e.file) && e.allow.includes(target.name)) used.add(e);
    }
  }
  return exceptions.filter((e) => !used.has(e));
}
