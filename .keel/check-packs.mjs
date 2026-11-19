#!/usr/bin/env node
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


const IGNORE = /^(node_modules|dist|coverage|\.git|\.keel|\.devin|\.claude|\.cursor|\.windsurf|\.codex)\//;
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

const IGNORE_LINE_RE = /keel-ignore\s+([\w./-]+)\s*:\s*\S/;
const IGNORE_FILE_RE = /keel-ignore-file\s+([\w./-]+)\s*:\s*\S/;
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
    const rawLines = raw.split("\n");
    if (rawLines.some((l) => IGNORE_FILE_RE.test(l) && l.includes(c.id))) continue;
    const text = c.scope === "raw" ? raw : mask(raw, c.scope === "code", rel.endsWith(".py") ? "py" : "c");
    if (c.kind === "require_regex") {
      if (!re.test(text)) sink.push(rel + "  [" + c.id + "] " + c.message + "  (required pattern absent)");
      continue;
    }
    for (const m of text.matchAll(re)) {
      const line = text.slice(0, m.index).split("\n").length;
      const srcLine = rawLines[line - 1] ?? "";
      if (IGNORE_LINE_RE.test(srcLine) && srcLine.includes(c.id)) continue;
      sink.push(rel + ":" + line + "  [" + c.id + "] " + c.message);
    }
  }
}
if (warnings.length) console.error("keel: pack check warnings\n" + warnings.map((v) => "  " + v).join("\n"));
if (violations.length) {
  console.error("keel: pack check violations\n" + violations.map((v) => "  " + v).join("\n"));
  process.exit(1);
}
