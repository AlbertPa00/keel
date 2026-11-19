const BEGIN = "<!-- keel:begin -->";
const END = "<!-- keel:end -->";

export const MANAGED = { begin: BEGIN, end: END };

/** Insert or replace the keel managed block inside markdown. Returns new content + whether a block existed. */
export function upsertManagedBlock(existing: string | null, blockBody: string): { content: string; existed: boolean } {
  const block = `${BEGIN}\n${blockBody.trimEnd()}\n${END}`;
  if (existing === null) return { content: `${block}\n`, existed: false };
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    const after = end + END.length;
    const content = existing.slice(0, start) + block + existing.slice(after);
    return { content, existed: true };
  }
  const sep = existing.endsWith("\n") || existing.length === 0 ? "" : "\n";
  return { content: `${existing}${sep}\n${block}\n`, existed: false };
}

/** Remove the keel managed block; returns cleaned content (null if file becomes empty). */
export function stripManagedBlock(existing: string): string | null {
  const start = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (start === -1 || end === -1 || end <= start) return existing;
  const after = end + END.length;
  let out = existing.slice(0, start) + existing.slice(after);
  out = out.replace(/\n{3,}/g, "\n\n");
  const trimmed = out.trim();
  return trimmed === "" ? null : `${trimmed}\n`;
}
