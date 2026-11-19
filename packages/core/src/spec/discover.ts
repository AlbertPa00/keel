import { dirname } from "node:path";
import { importGraph } from "../graph.js";
import type { BoundaryException, Layer } from "./schema.js";

/**
 * `keel init --discover` — derive architecture.layers + ratchet exceptions from
 * the real import graph instead of asking a human to guess globs.
 *
 * Algorithm:
 *  1. Group source files into module dirs (src/<seg>, packages/<pkg>/src/<seg>, <a>/<b>).
 *  2. Build the directed group-level edge multiset from import edges.
 *  3. Orient each group pair by majority direction; minority file edges become
 *     ratchet exceptions. Ties keep both directions — genuine cycles.
 *  4. Tarjan SCC on the oriented graph — only real cycles merge into one layer.
 *  5. Order layers by DAG topological rank — a group that imports nothing is
 *     innermost; each layer may_import every earlier layer.
 */

export interface DiscoveredArchitecture {
  layers: Layer[];
  exceptions: BoundaryException[];
  /** Human-readable notes for the init report. */
  notes: string[];
}

/** Repo-relative dir → module group path, or null for loose root files. */
function groupOf(rel: string): string | null {
  const d = dirname(rel);
  if (d === ".") return null;
  const pkg = d.match(/^(packages|apps|crates|libs|services|modules|components)\/([^/]+)\/src\/([^/]+)/);
  if (pkg) return `${pkg[1]}/${pkg[2]}/src/${pkg[3]}`;
  const pkgTop = d.match(/^(packages|apps|crates|libs|services|modules|components)\/([^/]+)/);
  if (pkgTop) return `${pkgTop[1]}/${pkgTop[2]}`;
  const src = d.match(/^src\/([^/]+)/);
  if (src) return `src/${src[1]}`;
  if (d === "src") return "src";
  const top = d.match(/^([^/]+)\/([^/]+)/);
  if (top) return `${top[1]}/${top[2]}`;
  return d;
}

/** Tarjan's SCC — returns groups of unit keys that import in a cycle. */
function stronglyConnected(nodes: string[], adj: Map<string, Set<string>>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;
  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const scc: string[] = [];
      for (;;) {
        const w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
        if (w === v) break;
      }
      sccs.push(scc);
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return sccs;
}

const SEP = "|";

export function discoverArchitecture(dir: string): DiscoveredArchitecture {
  const edges = importGraph(dir).filter((e) => e.to !== null);

  const groupCache = new Map<string, string>();
  const groupOfFile = (rel: string): string | null => {
    if (!groupCache.has(rel)) groupCache.set(rel, groupOf(rel) ?? "");
    return groupCache.get(rel) || null;
  };

  const weight = new Map<string, number>(); // "from|to" directed group-edge weight
  const fileEdges: { from: string; gFrom: string; gTo: string }[] = [];
  for (const e of edges) {
    const gFrom = groupOfFile(e.from);
    const gTo = groupOfFile(e.to!);
    if (!gFrom || !gTo || gFrom === gTo) continue;
    const key = `${gFrom}${SEP}${gTo}`;
    weight.set(key, (weight.get(key) ?? 0) + 1);
    fileEdges.push({ from: e.from, gFrom, gTo });
  }
  const nodes = [...new Set(fileEdges.flatMap((e) => [e.gFrom, e.gTo]))].sort();
  const notes: string[] = [];
  if (nodes.length === 0) return { layers: [], exceptions: [], notes: ["no internal imports found — nothing to discover"] };

  // Orient each group pair by majority direction; minority file edges → ratchet
  // exceptions. Ties keep both directions so real cycles still merge below.
  const dag = new Map<string, Set<string>>(nodes.map((n) => [n, new Set()]));
  const rawExceptions: { file: string; fromGroup: string; toGroup: string }[] = [];
  const pairSeen = new Set<string>();
  for (const [key, w] of [...weight.entries()].sort()) {
    const [a, b] = key.split(SEP) as [string, string];
    const pairKey = [a, b].sort().join(SEP);
    if (pairSeen.has(pairKey)) continue;
    pairSeen.add(pairKey);
    const rev = weight.get(`${b}${SEP}${a}`) ?? 0;
    if (w === rev) {
      dag.get(a)!.add(b);
      dag.get(b)!.add(a);
      continue;
    }
    const [outer, inner] = w > rev ? [a, b] : [b, a];
    dag.get(outer)!.add(inner);
    for (const fe of fileEdges.filter((e) => e.gFrom === inner && e.gTo === outer))
      rawExceptions.push({ file: fe.from, fromGroup: inner, toGroup: outer });
    if (rev > 0) notes.push(`ratcheted ${rev} reverse edge(s) ${inner} → ${outer}`);
  }

  // SCC condensation over the oriented graph — only genuine cycles merge.
  const sccs = stronglyConnected(nodes, dag);
  const unitOf = new Map<string, string>();
  const units: string[] = [];
  for (const scc of sccs) {
    const unit = [...scc].sort().join("+");
    for (const g of scc) unitOf.set(g, unit);
    units.push(unit);
    if (scc.length > 1) notes.push(`import cycle merged into one layer: ${[...scc].sort().join(" + ")}`);
  }
  units.sort();

  // Topological order, innermost first: a unit that imports nothing leads.
  const indeg = new Map<string, number>(units.map((u) => [u, 0]));
  const revAdj = new Map<string, Set<string>>(units.map((u) => [u, new Set()]));
  for (const [outer, inners] of dag) {
    for (const inner of inners) {
      const uo = unitOf.get(outer)!;
      const ui = unitOf.get(inner)!;
      if (uo === ui || revAdj.get(ui)!.has(uo)) continue;
      indeg.set(uo, indeg.get(uo)! + 1);
      revAdj.get(ui)!.add(uo);
    }
  }
  const ordered: string[] = [];
  const frontier = units.filter((u) => indeg.get(u) === 0).sort();
  const done = new Set<string>();
  while (frontier.length) {
    const u = frontier.shift()!;
    if (done.has(u)) continue;
    done.add(u);
    ordered.push(u);
    for (const o of [...(revAdj.get(u) ?? [])].sort()) {
      indeg.set(o, indeg.get(o)! - 1);
      if (indeg.get(o) === 0) frontier.push(o);
    }
    frontier.sort();
  }
  for (const u of units) if (!done.has(u)) ordered.push(u); // residual — safety net

  // Layer names: last non-"src" segment; dedupe with the package segment.
  const nameOf = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const u of ordered) {
    const first = u.split("+")[0]!;
    let name = (first.split("/").filter((s) => s !== "src").pop() ?? first).replace(/[^\w-]/g, "-");
    if (usedNames.has(name)) {
      const pkgSeg = u.split("/").filter((s) => !["src", "packages", "apps", "crates", "libs", "services", "modules", "components"].includes(s))[0];
      name = `${pkgSeg ?? "g"}-${name}`.replace(/[^\w-]/g, "-");
    }
    usedNames.add(name);
    nameOf.set(u, name);
  }

  const layers: Layer[] = ordered.map((u, i) => ({
    name: nameOf.get(u)!,
    paths: u.split("+").map((g) => `${g}/**`),
    may_import: ordered.slice(0, i).map((o) => nameOf.get(o)!),
  }));
  const exceptions: BoundaryException[] = rawExceptions
    .filter((e) => unitOf.get(e.fromGroup) !== unitOf.get(e.toGroup))
    .map((e) => ({
      file: e.file,
      allow: [nameOf.get(unitOf.get(e.toGroup)!)!],
      note: "discovered import debt",
    }));
  return { layers, exceptions, notes };
}
