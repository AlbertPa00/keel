/**
 * Two masks over the source, same positions:
 *  blankStrings=false — comments blanked, strings intact   → find import candidates
 *  blankStrings=true  — comments AND string interiors blanked → a match whose keyword
 *                       is invisible here sits inside a string literal → skip it.
 * Newlines are preserved everywhere so reported line numbers stay accurate.
 *
 * lang="c"  → // and /* *​/ comments, ' " ` strings  (ts/js/go/rust)
 * lang="py" → # comments, ' " plus ''' and """ triple strings  (python)
 * Twin of the MASK_FN fragment emitted into .keel/*.mjs — keep in lockstep.
 */
export type MaskLang = "c" | "py";

export function maskSource(src: string, blankStrings: boolean, lang: MaskLang = "c"): string {
  let out = "";
  let i = 0;
  let inStr: string | null = null;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (!inStr && (lang === "py" ? src[i] === "#" : two === "//")) {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (!inStr && lang === "c" && two === "/*") {
      const end = src.indexOf("*/", i + 2);
      const seg = end === -1 ? src.slice(i) : src.slice(i, end + 2);
      out += seg.replace(/[^\n]/g, " ");
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i]!;
    if (inStr) {
      if (src.startsWith(inStr, i)) {
        const delim = inStr;
        out += blankStrings ? delim.replace(/[^\n]/g, " ") : delim;
        inStr = null;
        i += delim.length;
        continue;
      }
      out += blankStrings && ch !== "\n" ? " " : ch;
      if (ch === "\\") {
        out += blankStrings && (src[i + 1] ?? "") !== "\n" ? " " : (src[i + 1] ?? "");
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (!inStr && lang === "py" && (src.startsWith("'''", i) || src.startsWith('"""', i))) {
      inStr = src.slice(i, i + 3);
      out += blankStrings ? "   " : inStr;
      i += 3;
      continue;
    }
    if (ch === '"' || ch === "'" || (lang === "c" && ch === "`")) {
      inStr = ch;
      out += blankStrings ? " " : ch;
      i++;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
