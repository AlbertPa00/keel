#!/usr/bin/env node
// keel: architecture boundary check — imports may only flow per may_import.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = JSON.parse(readFileSync(join(root, ".keel", "harness.json"), "utf8"));
const layers = harness.boundaries?.layers ?? [];
const exceptions = harness.boundaries?.exceptions ?? [];
const aliases = harness.boundaries?.aliases ?? {};
if (layers.length === 0) process.exit(0);

const globRe = (g) => {
  let out = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // **/ = zero or more leading segments; trailing ** = any suffix.
        if (g[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
        else { out += ".*"; i += 1; }
      } else out += "[^/]*";
    }
    else if (c === "?") out += "[^/]";
    else if ("\\^$.|+()[]{}".includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp("^" + out + "$");
};

// Two masks over the source, same positions:
//  textMask  — comments blanked, strings intact   → find import candidates
//  deepMask  — comments AND string interiors blanked → a match whose keyword
//              is invisible here sits inside a string literal → skip it.
// Newlines are preserved everywhere so reported line numbers stay accurate.
// lang "c"  → // and block comments, ' " ` strings      (ts/js/go/rust)
// lang "py" → # comments, ' " plus ''' and """ strings    (python)
// Twin of util/mask.ts — keep in lockstep.
const mask = (src, blankStrings, lang) => {
  lang = lang || "c";
  let out = "";
  let i = 0;
  let inStr = null;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (!inStr && (lang === "py" ? src[i] === "#" : two === "//")) {
      while (i < src.length && src[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (!inStr && lang === "c" && two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const seg = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += seg.replace(/[^\n]/g, " ");
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (inStr) {
      if (src.startsWith(inStr, i)) {
        const d = inStr;
        out += blankStrings ? d.replace(/[^\n]/g, " ") : d;
        inStr = null;
        i += d.length;
        continue;
      }
      out += blankStrings && ch !== "\n" ? " " : ch;
      if (ch === "\\") { out += blankStrings && (src[i + 1] ?? "") !== "\n" ? " " : (src[i + 1] ?? ""); i += 2; continue; }
      i++;
      continue;
    }
    if (!inStr && lang === "py" && (src.startsWith("'''", i) || src.startsWith('"""', i))) {
      inStr = src.slice(i, i + 3);
      out += blankStrings ? "   " : inStr;
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'" || (lang === "c" && ch === "`")) { inStr = ch; out += blankStrings ? " " : ch; i++; continue; }
    out += ch;
    i++;
  }
  return out;
};

// Import alias resolution — twin of graph.ts resolveAliasSpec.
// Aliases: {"@/*":"src/*", "pkg-name":"packages/x/src", "@app/*":"apps/web/src/*"}.
// Longest pattern wins; bare keys match prefix + "/rest"; "*" captures the middle.
const resolveAlias = (spec, aliases) => {
  let best = null;
  for (const key of Object.keys(aliases)) {
    const star = key.indexOf("*");
    if (star === -1) { if (spec !== key && !spec.startsWith(key + "/")) continue; }
    else {
      const pre = key.slice(0, star), suf = key.slice(star + 1);
      if (!spec.startsWith(pre) || !spec.endsWith(suf) || spec.length < pre.length + suf.length) continue;
    }
    if (!best || key.length > best.length) best = key;
  }
  if (!best) return null;
  const star = best.indexOf("*");
  if (star === -1) {
    const rest = spec.slice(best.length).replace(/^\//, "");
    // An empty alias value means "strip the prefix" (e.g. a go module path).
    return rest ? (aliases[best] ? aliases[best] + "/" + rest : rest) : (aliases[best] || null);
  }
  const mid = spec.slice(best.slice(0, star).length, spec.length - best.slice(star + 1).length);
  return aliases[best].replace("*", mid);
};


const resolveSpec = (spec, fromDir) => {
  if (spec.startsWith(".")) return join(fromDir, spec).split("\\").join("/");
  return resolveAlias(spec, aliases);
};
// Python: a.b.c → a/b/c; from .x / from ..x resolve against the file's package.
const resolvePy = (spec, fromDir) => {
  const dots = (spec.match(/^\.*/) || [""])[0].length;
  if (dots === 0) return spec.replace(/\./g, "/");
  let base = fromDir;
  for (let k = 1; k < dots; k++) base = dirname(base);
  const rest = spec.slice(dots).replace(/\./g, "/");
  const rel = rest ? (base === "." ? rest : base + "/" + rest) : (base === "." ? "" : base);
  return rel === "" ? null : rel;
};
// Rust: crate/self/super prefixes are path-relative; other specs hit crate aliases.
const crateRoots = {};
const crateRootOf = (rel) => {
  let d = dirname(rel);
  if (crateRoots[d] !== undefined) return crateRoots[d];
  for (;;) {
    if (existsSync(join(root, d === "." ? "Cargo.toml" : d + "/Cargo.toml"))) { crateRoots[d] = d === "." ? "" : d; return crateRoots[d]; }
    if (d === "." || d === "") { crateRoots[d] = ""; return ""; }
    d = dirname(d);
  }
};
const resolveRs = (spec, fromDir, rel) => {
  if (spec.startsWith("crate::")) {
    const r = crateRootOf(rel);
    return (r ? r + "/" : "") + "src/" + spec.slice(7).replace(/::/g, "/");
  }
  if (spec.startsWith("self::")) return join(fromDir, spec.slice(6).replace(/::/g, "/")).split("\\").join("/");
  let s = spec, ups = 0;
  while (s.startsWith("super::")) { ups++; s = s.slice(7); }
  if (ups > 0) {
    let base = fromDir;
    for (let k = 0; k < ups; k++) base = dirname(base);
    const rest = s.replace(/::/g, "/");
    return base === "." ? rest : base + "/" + rest;
  }
  return resolveAlias(s.replace(/::/g, "/"), aliases);
};
const layerOf = (rel) => {
  let best = null, score = -1;
  for (const l of layers) for (const g of l.paths) {
    if (!globRe(g).test(rel)) continue;
    const head = g.split("*")[0].length;
    if (head > score) { score = head; best = l; }
  }
  return best;
};

const IGNORE = /^(node_modules|dist|coverage|\.git|\.keel|\.devin|\.claude|\.cursor|\.windsurf|\.codex)\//;
const SRC_RE = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs)$/;
const walk = (dir, rel, out) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (IGNORE.test(r + (e.isDirectory() ? "/" : ""))) continue;
    if (e.isDirectory()) walk(join(dir, e.name), r, out);
    else if (SRC_RE.test(e.name)) out.push(r);
  }
};
const files = [];
walk(root, "", files);

const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
const KEYWORD_RE = /^(?:from|import|require)/;
const PY_IMPORT_RE = /\b(from\s+([.\w]+)\s+import|import\s+([\w.]+))/g;
const PY_KEYWORD_RE = /^(from|import)/;
const GO_BLOCK_RE = /\bimport\s*\(\s*((?:\s*[\w.]*\s*"[^"]+"\s*)+)\)/g;
const GO_ONE_RE = /\bimport\s+(?:[\w.]+\s+)?"([^"]+)"/g;
const GO_STR_RE = /"([^"]+)"/g;
const RS_USE_RE = /^\s*(?:pub\s+)?use\s+([A-Za-z_][\w:]*)/gm;
const CAND_SUFFIXES = [".ts", ".tsx", ".js", ".py", ".go", ".rs", "/index.ts", "/index.tsx", "/index.js", "/__init__.py", "/mod.rs", "/x"];
const STRIP_EXT = /\.(js|ts|jsx|tsx|mts|cts|mjs|cjs|py|go|rs)$/;

// Raw import hits per file — keyword-verified against the deep mask.
const rawImports = (rel, text, deep) => {
  const out = [];
  const kwVisible = (index, re) => re.test(deep.slice(index, index + 8));
  if (rel.endsWith(".py")) {
    for (const m of text.matchAll(PY_IMPORT_RE)) {
      if (!kwVisible(m.index, PY_KEYWORD_RE)) continue;
      out.push({ spec: m[2] ?? m[3], index: m.index });
    }
    return out;
  }
  if (rel.endsWith(".go")) {
    for (const m of text.matchAll(GO_BLOCK_RE)) {
      if (!kwVisible(m.index, /^import/)) continue;
      for (const s of m[0].matchAll(GO_STR_RE)) out.push({ spec: s[1], index: m.index + s.index });
    }
    for (const m of text.matchAll(GO_ONE_RE)) {
      if (!kwVisible(m.index, /^import/)) continue;
      out.push({ spec: m[1], index: m.index });
    }
    return out;
  }
  if (rel.endsWith(".rs")) {
    for (const m of text.matchAll(RS_USE_RE)) {
      const useIdx = m.index + m[0].search(/use\s/);
      if (!kwVisible(useIdx, /^use/)) continue;
      out.push({ spec: m[1], index: m.index });
    }
    return out;
  }
  for (const m of text.matchAll(IMPORT_RE)) {
    if (!KEYWORD_RE.test(deep.slice(m.index, m.index + 7))) continue;
    out.push({ spec: m[1], index: m.index });
  }
  return out;
};

const usedExc = new Set();
const violations = [];
for (const rel of files) {
  const src = layerOf(rel);
  if (!src) continue;
  const raw = readFileSync(join(root, rel), "utf8");
  const lang = rel.endsWith(".py") ? "py" : "c";
  const text = mask(raw, false, lang);
  const deep = mask(raw, true, lang);
  const dirRel = dirname(rel);
  for (const hit of rawImports(rel, text, deep)) {
    const spec = hit.spec;
    const resolved = rel.endsWith(".py") ? resolvePy(spec, dirRel)
      : rel.endsWith(".rs") ? resolveRs(spec, dirRel, rel)
      : resolveSpec(spec, dirRel);
    if (resolved === null) continue;
    const abs = resolved.replace(STRIP_EXT, "");
    const bases = rel.endsWith(".py") ? [abs, "src/" + abs] : [abs];
    const candidates = bases.flatMap((b) => [b, ...CAND_SUFFIXES.map((s) => b + s)]);
    const target = candidates.map(layerOf).find(Boolean);
    if (target && target.name !== src.name && !src.may_import.includes(target.name)) {
      // Ratchet lookup also records which exception entries are still load-bearing.
      let allowed = false;
      exceptions.forEach((e, i) => {
        if (globRe(e.file).test(rel) && (e.allow ?? []).includes(target.name)) { usedExc.add(i); allowed = true; }
      });
      if (!allowed) {
        const line = text.slice(0, hit.index).split("\n").length;
        violations.push(rel + ":" + line + "  [" + src.name + "] cannot import [" + target.name + "]  (" + spec + ")");
      }
    }
  }
}
// Shrink-only discipline: an exception entry that quarantines nothing is debt
// already paid — the gate fails until it is removed from harness.yaml.
const stale = exceptions.map((e, i) => i).filter((i) => !usedExc.has(i));
if (stale.length) {
  console.error(
    "keel: stale ratchet entries — remove them from harness.yaml (shrink-only):\n" +
      stale.map((i) => "  " + exceptions[i].file + "  allow [" + (exceptions[i].allow ?? []).join(",") + "]").join("\n"),
  );
}
if (violations.length) {
  console.error("keel: boundary violations\n" + violations.map(v => "  " + v).join("\n"));
}
if (violations.length || stale.length) process.exit(1);
