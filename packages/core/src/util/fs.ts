import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function fileSha(path: string): string | null {
  if (!existsSync(path)) return null;
  return sha256(readFileSync(path));
}

export function readText(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function readJson<T = unknown>(path: string): T | null {
  const raw = readText(path);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Normalize to forward-slash relative paths (windows-safe, deterministic output). */
export function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** Recursively list files under dir, returning forward-slash paths relative to dir. */
export function walkFiles(dir: string, ignore: RegExp[] = []): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (rel: string): void => {
    const abs = join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignore.some((re) => re.test(childRel))) continue;
      const childAbs = join(abs, entry.name);
      if (entry.isDirectory()) visit(childRel);
      else if (entry.isFile() && statSync(childAbs).isFile()) out.push(childRel);
    }
  };
  visit("");
  return out.sort();
}

/** ~4 chars per token — intentionally rough, used only for budget reporting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
