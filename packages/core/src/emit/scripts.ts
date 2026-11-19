/**
 * Static script bodies emitted into <project>/.keel/.
 * All project data comes from .keel/harness.json at runtime — these bodies
 * are byte-stable across projects, which makes them easy to audit.
 *
 * Shared logic lives in fragments (MASK_FN, GLOB_FN, ALIAS_FN, SNAP_FN) so the
 * emitted scripts stay self-contained while their semantics are written once.
 * Keep these fragments in lockstep with their TypeScript twins
 * (util/mask.ts, util/glob.ts, graph.ts) — the parity tests enforce it.
 */

const MASK_FN = `// Two masks over the source, same positions:
//  textMask  — comments blanked, strings intact   → find import candidates
//  deepMask  — comments AND string interiors blanked → a match whose keyword
//              is invisible here sits inside a string literal → skip it.
// Newlines are preserved everywhere so reported line numbers stay accurate.
// lang "c"  → // and block comments, ' " \` strings      (ts/js/go/rust)
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
      while (i < src.length && src[i] !== "\\n") { out += " "; i++; }
      continue;
    }
    if (!inStr && lang === "c" && two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const seg = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += seg.replace(/[^\\n]/g, " ");
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i];
    if (inStr) {
      if (src.startsWith(inStr, i)) {
        const d = inStr;
        out += blankStrings ? d.replace(/[^\\n]/g, " ") : d;
        inStr = null;
        i += d.length;
        continue;
      }
      out += blankStrings && ch !== "\\n" ? " " : ch;
      if (ch === "\\\\") { out += blankStrings && (src[i + 1] ?? "") !== "\\n" ? " " : (src[i + 1] ?? ""); i += 2; continue; }
      i++;
      continue;
    }
    if (!inStr && lang === "py" && (src.startsWith("'''", i) || src.startsWith('"""', i))) {
      inStr = src.slice(i, i + 3);
      out += blankStrings ? "   " : inStr;
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'" || (lang === "c" && ch === "\`")) { inStr = ch; out += blankStrings ? " " : ch; i++; continue; }
    out += ch;
    i++;
  }
  return out;
};
`;

const GLOB_FN = `const globRe = (g) => {
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
    else if ("\\\\^$.|+()[]{}".includes(c)) out += "\\\\" + c;
    else out += c;
  }
  return new RegExp("^" + out + "$");
};
`;

const ALIAS_FN = `// Import alias resolution — twin of graph.ts resolveAliasSpec.
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
    const rest = spec.slice(best.length).replace(/^\\//, "");
    // An empty alias value means "strip the prefix" (e.g. a go module path).
    return rest ? (aliases[best] ? aliases[best] + "/" + rest : rest) : (aliases[best] || null);
  }
  const mid = spec.slice(best.slice(0, star).length, spec.length - best.slice(star + 1).length);
  return aliases[best].replace("*", mid);
};
`;

const SNAP_FN = `// Worktree snapshot — the authoritative "did this turn change anything" check.
// git status --porcelain covers tracked + untracked changes in one call; the
// mtime fallback keeps non-git directories working. .keel/state/ is always
// excluded — harness-internal churn is not user mutation.
import * as __snapFs from "node:fs";
import { spawnSync as __snapSpawn } from "node:child_process";
import { createHash as __snapHash } from "node:crypto";

const SNAP_IGNORE = /^(node_modules|dist|coverage|\\.git|\\.keel\\/state)\\//;
const worktreeSnap = (root) => {
  const git = __snapSpawn("git", ["status", "--porcelain=v2", "-uall", "--", "."], { cwd: root, encoding: "utf8" });
  if (git.status === 0 && typeof git.stdout === "string") {
    const body = git.stdout.split("\\n").filter((l) => !l.includes(".keel/state")).join("\\n");
    return "g:" + __snapHash("sha256").update(body).digest("hex");
  }
  const parts = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = __snapFs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (SNAP_IGNORE.test(r + (e.isDirectory() ? "/" : ""))) continue;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else {
        try { const st = __snapFs.statSync(join(dir, e.name)); parts.push(r + ":" + st.size + ":" + st.mtimeMs); }
        catch { /* vanished mid-scan */ }
      }
    }
  };
  walk(root, "");
  parts.sort();
  return "f:" + __snapHash("sha256").update(parts.join("\\n")).digest("hex");
};
`;

export const CHECK_BOUNDARIES = `#!/usr/bin/env node
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

${GLOB_FN}
${MASK_FN}
${ALIAS_FN}

const resolveSpec = (spec, fromDir) => {
  if (spec.startsWith(".")) return join(fromDir, spec).split("\\\\").join("/");
  return resolveAlias(spec, aliases);
};
// Python: a.b.c → a/b/c; from .x / from ..x resolve against the file's package.
const resolvePy = (spec, fromDir) => {
  const dots = (spec.match(/^\\.*/) || [""])[0].length;
  if (dots === 0) return spec.replace(/\\./g, "/");
  let base = fromDir;
  for (let k = 1; k < dots; k++) base = dirname(base);
  const rest = spec.slice(dots).replace(/\\./g, "/");
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
  if (spec.startsWith("self::")) return join(fromDir, spec.slice(6).replace(/::/g, "/")).split("\\\\").join("/");
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

const IGNORE = /^(node_modules|dist|coverage|\\.git|\\.keel|\\.devin|\\.claude|\\.cursor|\\.windsurf|\\.codex)\\//;
const SRC_RE = /\\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs)$/;
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

const IMPORT_RE = /(?:from|import|require)\\s*\\(?\\s*["']([^"']+)["']/g;
const KEYWORD_RE = /^(?:from|import|require)/;
const PY_IMPORT_RE = /\\b(from\\s+([.\\w]+)\\s+import|import\\s+([\\w.]+))/g;
const PY_KEYWORD_RE = /^(from|import)/;
const GO_BLOCK_RE = /\\bimport\\s*\\(\\s*((?:\\s*[\\w.]*\\s*"[^"]+"\\s*)+)\\)/g;
const GO_ONE_RE = /\\bimport\\s+(?:[\\w.]+\\s+)?"([^"]+)"/g;
const GO_STR_RE = /"([^"]+)"/g;
const RS_USE_RE = /^\\s*(?:pub\\s+)?use\\s+([A-Za-z_][\\w:]*)/gm;
const CAND_SUFFIXES = [".ts", ".tsx", ".js", ".py", ".go", ".rs", "/index.ts", "/index.tsx", "/index.js", "/__init__.py", "/mod.rs", "/x"];
const STRIP_EXT = /\\.(js|ts|jsx|tsx|mts|cts|mjs|cjs|py|go|rs)$/;

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
      const useIdx = m.index + m[0].search(/use\\s/);
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
        const line = text.slice(0, hit.index).split("\\n").length;
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
    "keel: stale ratchet entries — remove them from harness.yaml (shrink-only):\\n" +
      stale.map((i) => "  " + exceptions[i].file + "  allow [" + (exceptions[i].allow ?? []).join(",") + "]").join("\\n"),
  );
}
if (violations.length) {
  console.error("keel: boundary violations\\n" + violations.map(v => "  " + v).join("\\n"));
}
if (violations.length || stale.length) process.exit(1);
`;

export const CHECK_DRIFT = `#!/usr/bin/env node
// keel: offline drift check — every managed file in keel.lock.json must exist
// on disk and match its recorded SHA-256. Runs anywhere node exists; no keel
// install required (the CI gate alongside .keel/verify.mjs).
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const lockPath = join(root, "keel.lock.json");
if (!existsSync(lockPath)) {
  console.error("keel: keel.lock.json missing — run keel apply");
  process.exit(1);
}
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const bad = [];
for (const e of lock.files ?? []) {
  const abs = join(root, e.path);
  if (!existsSync(abs)) { bad.push("missing:   " + e.path); continue; }
  const sha = createHash("sha256").update(readFileSync(abs)).digest("hex");
  if (sha !== e.sha256) bad.push("modified:  " + e.path);
}
if (bad.length) {
  console.error("keel: drift detected — generated files were edited or deleted; run keel apply:\\n" + bad.map((b) => "  " + b).join("\\n"));
  process.exit(1);
}
`;

export const CHECK_PACKS = `#!/usr/bin/env node
// keel: pack check gate — mechanical rules from selected packs (emits.checks).
// "code" scope runs over the deep mask (comments + string interiors blanked);
// "raw" scope matches bytes as-is. Inline suppression needs a reason:
//   // keel-ignore <pack>/<check>: <reason>        → suppresses that line
//   // keel-ignore-file <pack>/<check>: <reason>   → suppresses the file
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = JSON.parse(readFileSync(join(root, ".keel", "harness.json"), "utf8"));
const checks = harness.checks ?? [];
if (checks.length === 0) process.exit(0);

${GLOB_FN}
${MASK_FN}

const IGNORE = /^(node_modules|dist|coverage|\\.git|\\.keel|\\.devin|\\.claude|\\.cursor|\\.windsurf|\\.codex)\\//;
const walk = (dir, rel, out) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (IGNORE.test(r + (e.isDirectory() ? "/" : ""))) continue;
    if (e.isDirectory()) walk(join(dir, e.name), r, out);
    else out.push(r);
  }
};
const files = [];
walk(root, "", files);

const IGNORE_LINE_RE = /keel-ignore\\s+([\\w./-]+)\\s*:\\s*\\S/;
const IGNORE_FILE_RE = /keel-ignore-file\\s+([\\w./-]+)\\s*:\\s*\\S/;
const violations = [];
const warnings = [];
// severity "warn" reports without failing — hygiene findings stay visible
// without turning adoption into a flag-day.

for (const c of checks) {
  const incl = c.globs.map(globRe);
  const excl = (c.exclude_globs ?? []).map(globRe);
  let flags = c.flags || "";
  if (c.kind === "forbid_regex" && !flags.includes("g")) flags += "g";
  if (c.kind === "require_regex") flags = flags.replace(/g/g, "");
  let re;
  try { re = new RegExp(c.pattern, flags); }
  catch (e) { violations.push("<harness>  [" + c.id + "] invalid pattern: " + e.message); continue; }

  const matched = files.filter((rel) => incl.some((g) => g.test(rel)) && !excl.some((g) => g.test(rel)));
  const sink = c.severity === "warn" ? warnings : violations;
  for (const rel of matched) {
    const raw = readFileSync(join(root, rel), "utf8");
    const rawLines = raw.split("\\n");
    if (rawLines.some((l) => IGNORE_FILE_RE.test(l) && l.includes(c.id))) continue;
    const text = c.scope === "raw" ? raw : mask(raw, c.scope === "code", rel.endsWith(".py") ? "py" : "c");
    if (c.kind === "require_regex") {
      if (!re.test(text)) sink.push(rel + "  [" + c.id + "] " + c.message + "  (required pattern absent)");
      continue;
    }
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\\n").length;
      const srcLine = rawLines[line - 1] ?? "";
      if (IGNORE_LINE_RE.test(srcLine) && srcLine.includes(c.id)) continue;
      sink.push(rel + ":" + line + "  [" + c.id + "] " + c.message);
    }
  }
}
if (warnings.length) console.error("keel: pack check warnings\\n" + warnings.map((v) => "  " + v).join("\\n"));
if (violations.length) {
  console.error("keel: pack check violations\\n" + violations.map((v) => "  " + v).join("\\n"));
  process.exit(1);
}
`;

export const VERIFY = `#!/usr/bin/env node
// keel: verify gate — boundary check first, then the project's verify commands.
// --fast swaps the project command list for harness.verify_fast (Stop hook path).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const keelDir = dirname(fileURLToPath(import.meta.url));
const root = join(keelDir, "..");
const harness = JSON.parse(readFileSync(join(keelDir, "harness.json"), "utf8"));

const fast = process.argv.includes("--fast");
const projectCmds = fast ? (harness.verify_fast ?? harness.verify ?? []) : (harness.verify ?? []);

const steps = [];
if (existsSync(join(keelDir, "check-boundaries.mjs")) && (harness.boundaries?.layers ?? []).length)
  steps.push({ name: "boundaries", cmd: "node .keel/check-boundaries.mjs" });
if (existsSync(join(keelDir, "check-packs.mjs")) && (harness.checks ?? []).length)
  steps.push({ name: "packs", cmd: "node .keel/check-packs.mjs" });
if (existsSync(join(keelDir, "check-style.mjs")) && (harness.style?.max_nesting || harness.style?.max_function_lines))
  steps.push({ name: "style", cmd: "node .keel/check-style.mjs" });
for (const cmd of projectCmds) steps.push({ name: cmd, cmd });

let failed = false;
for (const step of steps) {
  const res = spawnSync(step.cmd, { cwd: root, shell: true, encoding: "utf8", timeout: (harness.verify_timeout_sec ?? 180) * 1000 });
  const out = ((res.stdout ?? "") + (res.stderr ?? "")).trim();
  if (res.status !== 0) {
    failed = true;
    const tail = out.split("\\n").slice(-30).join("\\n");
    console.error("keel verify FAIL [" + step.name + "]\\n" + tail);
    break;
  }
}
process.exit(failed ? 1 : 0);
`;

export const TURN_STAMP = `#!/usr/bin/env node
// keel: UserPromptSubmit hook — stamp the current turn and snapshot the worktree.
// The stop hook later compares a fresh snapshot: an identical tree means the
// turn provably changed nothing and verify is skipped — no command guessing.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stateDir = join(root, ".keel", "state");

${SNAP_FN}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    const key = \`\${payload.session_id ?? "s"}:\${payload.prompt_id ?? "p"}\`.replace(/[^\\w.-]/g, "_");
    mkdirSync(stateDir, { recursive: true });
    // a new turn starts clean — sweep markers from finished/abandoned turns
    for (const f of readdirSync(stateDir)) if (f.endsWith(".dirty") || f.endsWith(".snap")) rmSync(join(stateDir, f), { force: true });
    writeFileSync(join(stateDir, "current"), key, "utf8");
    writeFileSync(join(stateDir, key + ".snap"), worktreeSnap(root), "utf8");
  } catch { /* best effort — never block a prompt */ }
  process.exit(0);
});
`;

export const STOP_VERIFY = `#!/usr/bin/env node
// keel: Stop hook — verify once per mutated turn; block premature completion (exit 2).
// Turn dirtiness is proven by comparing worktree snapshots, not by guessing
// which shell commands mutate — unknown read-only commands cost zero verify.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const stateDir = join(root, ".keel", "state");

${SNAP_FN}

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(input || "{}");
    if (payload.stop_hook_active) process.exit(0); // avoid infinite block loop
  } catch { /* ignore */ }

  // Snapshot check: identical worktree → nothing mutated → skip the gate.
  // Missing stamp/snapshot (resumed session, hooks added mid-session) → verify conservatively.
  try {
    const key = String(readFileSync(join(stateDir, "current"), "utf8")).trim();
    const snapFile = join(stateDir, key + ".snap");
    if (key && existsSync(snapFile) && worktreeSnap(root) === readFileSync(snapFile, "utf8").trim()) {
      process.exit(0);
    }
  } catch { /* no stamp file → verify conservatively */ }

  const res = spawnSync(process.execPath, [".keel/verify.mjs", "--fast"], { cwd: root, encoding: "utf8" });
  if (res.status === 0) process.exit(0);
  const tail = ((res.stdout ?? "") + (res.stderr ?? "")).trim().split("\\n").slice(-15).join("\\n");
  const reason = "keel verify failed — fix the failures before ending the turn:\\n" + tail;
  process.stderr.write(reason + "\\n");
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(2);
});
`;

export const CHECK_STYLE = `#!/usr/bin/env node
// keel: style gate — heuristic max-nesting + function-length checks (advisory-grade, not AST-exact).
// Braces are counted on the deep mask (comments + string interiors blanked) so
// brackets inside strings, templates, regexes, and comments never skew depth.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const harness = JSON.parse(readFileSync(join(root, ".keel", "harness.json"), "utf8"));
const maxNesting = harness.style?.max_nesting ?? 0;
const maxFnLines = harness.style?.max_function_lines ?? 0;
if (!maxNesting && !maxFnLines) process.exit(0);

const IGNORE = /^(node_modules|dist|coverage|\\.git|\\.keel|\\.devin|\\.claude|\\.cursor|\\.windsurf|\\.codex)\\//;
const SCAN = /\\.(ts|tsx|mts|cts)$/;
const walk = (dir, rel, out) => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + "/" + e.name : e.name;
    if (IGNORE.test(r + (e.isDirectory() ? "/" : ""))) continue;
    if (e.isDirectory()) walk(join(dir, e.name), r, out);
    else if (SCAN.test(e.name)) out.push(r);
  }
};
const files = [];
walk(root, "", files);

const FN_START = /^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\s*\\w*|[\\w]+\\s*[:=]\\s*(?:async\\s*)?(?:function\\s*)?[(\\w]|(?:public|private|protected|static|async|get|set|readonly|override|abstract)\\s+[\\w]+\\s*\\()/;
const violations = [];

${MASK_FN}

for (const rel of files) {
  const lines = mask(readFileSync(join(root, rel), "utf8"), true).split("\\n");
  let depth = 0;
  const fnStack = [];
  for (let i = 0; i < lines.length; i++) {
    const cleaned = lines[i];
    const opens = (cleaned.match(/[{]/g) || []).length;
    const closes = (cleaned.match(/[}]/g) || []).length;
    const net = opens - closes;
    if (maxNesting) {
      depth += net;
      if (depth > maxNesting)
        violations.push(rel + ":" + (i + 1) + "  brace nesting depth " + depth + " exceeds max " + maxNesting);
    }
    if (maxFnLines) {
      if (FN_START.test(cleaned) && net > 0) {
        fnStack.push({ line: i + 1, depth: net });
      } else {
        for (const e of fnStack) e.depth += net;
        while (fnStack.length && fnStack[fnStack.length - 1].depth <= 0) {
          const e = fnStack.pop();
          const len = i + 1 - e.line;
          if (len > maxFnLines) violations.push(rel + ":" + e.line + "  function is " + len + " lines (max " + maxFnLines + ")");
        }
      }
    }
  }
}
if (violations.length) {
  const dedup = [...new Set(violations)];
  console.error("keel: style violations\\n" + dedup.map(v => "  " + v).join("\\n"));
  process.exit(1);
}
`;

export const POST_COMPACTION = `#!/usr/bin/env node
// keel: PostCompaction hook — re-inject the project's enforced invariants.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  let event = "PostCompaction";
  try { event = JSON.parse(input || "{}").hook_event_name ?? event; } catch { /* ignore */ }
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let invariants = [];
  try {
    invariants = JSON.parse(readFileSync(join(root, ".keel", "harness.json"), "utf8")).invariants ?? [];
  } catch { /* ignore */ }
  if (invariants.length === 0) process.exit(0);
  const ctx = "Active harness invariants (must hold for every change):\\n" + invariants.map((l) => "- " + l).join("\\n");
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: ctx },
  }));
});
`;
