import type { Pack } from "../catalog/pack.js";
import type { Fingerprint } from "../fingerprint.js";
import type { HarnessSpec, Slot } from "../spec/schema.js";
import { SLOTS } from "../spec/schema.js";

export interface Rejection {
  pack: string;
  reason: string;
}

export interface Resolution {
  /** Selected packs, deterministic order (slot order, then id). */
  selected: Pack[];
  bySlot: Partial<Record<Slot, Pack[]>>;
  rejected: Rejection[];
  conflicts: Rejection[];
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 2),
  );
}

function intentScore(pack: Pack, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  const hay = tokens(`${pack.name} ${pack.summary} ${pack.tags.join(" ")}`);
  let hits = 0;
  for (const t of terms) if (hay.has(t)) hits++;
  return (hits / terms.size) * 5;
}

/** Version-compat check: pack.stack_version majors must match known majors (unknown = pass). */
function versionOk(pack: Pack, known: Record<string, string | null>): boolean {
  for (const [key, req] of Object.entries(pack.stack_version)) {
    const have = known[key];
    if (have !== null && have !== undefined && have !== req.replace(/[^\d]/g, "")) return false;
  }
  return true;
}

/**
 * Deterministic per-slot selection.
 * Score = stack-key overlap (×10) + principle-key overlap (×6) + intent terms (≤5) − token_cost/1000.
 */
export function resolvePacks(
  spec: HarnessSpec,
  fp: Fingerprint | null,
  catalog: Map<string, Pack>,
): Resolution {
  const intent = tokens(spec.project.intent);
  const frameworks = new Set(
    [...spec.stack.frameworks, ...Object.keys(fp?.frameworks ?? {}), spec.stack.language, fp?.language ?? ""].filter(
      (f) => f !== "",
    ),
  );
  const principles = new Set(spec.style.principles);
  const rejected: Rejection[] = [];
  const conflicts: Rejection[] = [];
  const bySlot: Partial<Record<Slot, Pack[]>> = {};

  const scored = [...catalog.values()].map((pack) => {
    let score = 0;
    for (const k of pack.stack_keys) if (frameworks.has(k)) score += 10;
    for (const k of pack.principle_keys) if (principles.has(k)) score += 6;
    score += intentScore(pack, intent) - pack.token_cost / 1000;
    return { pack, score };
  });

  for (const slot of SLOTS) {
    const cands = scored
      .filter(({ pack }) => pack.slot === slot)
      .sort((a, b) => b.score - a.score || a.pack.id.localeCompare(b.pack.id));

    const chosen = new Map<string, Pack>();

    // Hard rules first: version compat + paradigm clash + explicit exclusions.
    for (const { pack, score } of cands) {
      const explicit = spec.packs.include.includes(pack.id);
      if (spec.packs.exclude.includes(pack.id)) {
        rejected.push({ pack: pack.id, reason: "excluded in spec" });
        continue;
      }
      if (!versionOk(pack, fp?.frameworks ?? {})) {
        rejected.push({ pack: pack.id, reason: `version requirement ${JSON.stringify(pack.stack_version)} not met` });
        continue;
      }
      // Style-slot paradigm packs ("fp"/"oop") never sneak in on stack/principle
      // overlap alone: a declared paradigm auto-includes its own pack; "hybrid"
      // means undecided, so they require packs.include. Non-style packs keep the
      // declared-paradigm clash rule only (a react pack may lean fp legitimately).
      if (pack.paradigm !== "neutral") {
        if (spec.style.paradigm === "hybrid" && pack.slot === "style" && !explicit) {
          rejected.push({
            pack: pack.id,
            reason: "paradigm pack skipped — spec paradigm is hybrid (set style.paradigm or packs.include to opt in)",
          });
          continue;
        }
        if (spec.style.paradigm !== "hybrid" && pack.paradigm !== spec.style.paradigm) {
          rejected.push({
            pack: pack.id,
            reason: `paradigm ${pack.paradigm} conflicts with spec ${spec.style.paradigm}`,
          });
          continue;
        }
      }

      // safety.profile=minimal opts out of the curated baseline unless explicitly included.
      if (slot === "safety" && pack.id === "safety/baseline" && spec.safety.profile === "minimal" && !explicit) {
        rejected.push({ pack: pack.id, reason: "safety.profile=minimal — baseline skipped (include it explicitly to override)" });
        continue;
      }
      const threshold = slot === "stack" ? 8 : slot === "safety" ? 0 : 5;
      const baselineForced = slot === "safety" && pack.id === "safety/baseline" && spec.safety.profile !== "minimal";
      if (explicit || score >= threshold || baselineForced) {
        chosen.set(pack.id, pack);
      } else {
        rejected.push({ pack: pack.id, reason: `score ${score.toFixed(1)} below threshold ${threshold}` });
      }
    }

    // Spec-declared architecture style auto-includes its pack.
    if (slot === "architecture" && spec.architecture.style) {
      for (const { pack } of cands) {
        if (pack.id === `architecture/${spec.architecture.style}` && !spec.packs.exclude.includes(pack.id))
          chosen.set(pack.id, pack);
      }
    }
    // Declared paradigm auto-includes its strict style pack (fp → fp-strict, oop → oop-strict).
    if (slot === "style" && spec.style.paradigm !== "hybrid") {
      for (const { pack } of cands) {
        if (pack.id === `style/${spec.style.paradigm}-strict` && !spec.packs.exclude.includes(pack.id))
          chosen.set(pack.id, pack);
      }
    }
    // Autonomy mode pulls the verified-completion workflow pack.
    if (slot === "workflow" && spec.autonomy.mode !== "guided" && spec.autonomy.stop_hook) {
      const vc = catalog.get("workflow/verified-completion");
      if (vc && !spec.packs.exclude.includes(vc.id)) chosen.set(vc.id, vc);
    }

    // Conflict pruning: pairwise conflicts_with + paradigm clash inside selection.
    const ids = [...chosen.keys()].sort();
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const pa = chosen.get(a);
        const pb = chosen.get(b);
        if (pa && pb && pa.conflicts_with.includes(pb.id)) {
          const loser = (pa.token_cost >= pb.token_cost ? pa : pb).id;
          chosen.delete(loser);
          conflicts.push({ pack: loser, reason: `conflicts with ${loser === a ? b : a}` });
        }
      }
    }

    // A pack auto-included above must not linger in the rejected list.
    for (let i = rejected.length - 1; i >= 0; i--) {
      if (chosen.has(rejected[i]!.pack)) rejected.splice(i, 1);
    }

    if (chosen.size) bySlot[slot] = [...chosen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  const selected = SLOTS.flatMap((s) => bySlot[s] ?? []);
  return { selected, bySlot, rejected, conflicts };
}

export interface SearchHit {
  pack: Pack;
  score: number;
  matched: string[];
}

/** Ad-hoc catalog search — grouped per slot, deterministic order (score desc, id asc). */
export function searchCatalog(catalog: Map<string, Pack>, query: string, slot?: Slot): SearchHit[] {
  const terms = tokens(query);
  const hits: SearchHit[] = [];
  for (const pack of catalog.values()) {
    if (slot && pack.slot !== slot) continue;
    const hay = tokens(`${pack.id} ${pack.name} ${pack.summary} ${pack.tags.join(" ")} ${pack.stack_keys.join(" ")}`);
    const matched = [...terms].filter((t) => hay.has(t));
    const score = matched.length === 0 ? 0 : (matched.length / terms.size) * 5 - pack.token_cost / 1000;
    hits.push({ pack, score, matched });
  }
  return hits.filter((h) => h.score > 0).sort((a, b) => b.score - a.score || a.pack.id.localeCompare(b.pack.id));
}
