/**
 * Minimal glob matcher for the subset keel uses: `**`, `*`, `?`, literal dirs.
 * Deterministic, dependency-free. Paths are forward-slash relative.
 */

export function globToRegex(glob: string): RegExp {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // `**/` matches zero or more leading segments (root-level files included)
          out += "(?:.*/)?";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      out += "[^/]";
      i += 1;
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegex(glob).test(path);
}

/** Longest-literal-head match: returns the most specific glob that matches. */
export function bestGlobMatch(path: string, globs: string[]): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const g of globs) {
    if (!matchesGlob(path, g)) continue;
    const literalHead = g.split("*")[0] ?? "";
    if (literalHead.length > bestScore) {
      bestScore = literalHead.length;
      best = g;
    }
  }
  return best;
}

/** Expand `dir/**` style globs to a directory prefix for file collection. */
export function globBaseDir(glob: string): string {
  const idx = glob.search(/[*?]/);
  const head = idx === -1 ? glob : glob.slice(0, idx);
  const slash = head.lastIndexOf("/");
  return slash === -1 ? "" : head.slice(0, slash);
}
