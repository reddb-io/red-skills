import {
  recall,
  type RecalledNode,
  type RecallDiagnostics,
  type RecallScope,
  type RecallStore,
} from "./engine.js";
import type { MemoryStore } from "./graph-store.js";
import { hybridRecall, type Ranking } from "./hybrid-recall.js";
import { appendEngineOpEvent } from "./memory-events.js";

export interface GraphRecallHit {
  /** Engine-assigned node rid, as a string for uniform CLI printing. */
  id: string;
  rid: number;
  label: string;
  node_type: string;
  score: number;
  excerpt: string;
}

export interface GraphRecallResult {
  hits: GraphRecallHit[];
  diagnostics: RecallDiagnostics;
}

/**
 * CLI-facing recall: runs the engine's graph-aware recall to assemble the
 * candidate set (scope filtering, supersession resolution, graph expansion,
 * confidence attachment) and then re-orders the candidates by folding three
 * per-axis rankings through Reciprocal Rank Fusion (#180):
 *
 *   - keyword: `store.searchText` order
 *   - vector:  `store.searchVector` order (when available)
 *   - graph:   candidate order by graph-distance (depth asc, engine score desc)
 *
 * RRF carries no per-source weights, so a hit's final position is determined
 * purely by where it landed in each contributing ranking. Hits the engine
 * surfaces always remain — the graph ranking covers the full candidate set —
 * but their order now blends across vector, keyword, and graph-distance signals
 * without any hand-tuned multiplier. See `hybrid-recall.ts` for the composer.
 */
export async function graphRecall(
  store: RecallStore,
  query: string,
  limit = 10,
  opts: { includeSuperseded?: boolean; scope?: RecallScope; now?: number } = {},
): Promise<GraphRecallHit[]> {
  return (await graphRecallResult(store, query, limit, opts)).hits;
}

function isMemoryStore(store: RecallStore): store is MemoryStore {
  return typeof (store as Partial<MemoryStore>).emitEngineOp === "function";
}

export async function graphRecallResult(
  store: RecallStore,
  query: string,
  limit = 10,
  opts: { includeSuperseded?: boolean; scope?: RecallScope; now?: number } = {},
): Promise<GraphRecallResult> {
  const { nodes, diagnostics } = await recall(store, query, {
    k: limit,
    depth: 1,
    includeSuperseded: opts.includeSuperseded,
    scope: opts.scope,
    now: opts.now,
  });

  if (isMemoryStore(store)) {
    await appendEngineOpEvent(store, {
      op: "recall",
      outcome: nodes.length > 0 ? "hit" : "miss",
      layer: "L3",
      query,
      hit_count: nodes.length,
    });
  }

  if (nodes.length === 0) {
    return { hits: [], diagnostics };
  }

  const candidates = new Map<number, RecalledNode>();
  for (const node of nodes) candidates.set(node.rid, node);

  const rankings: Ranking[] = [
    { source: "keyword", rids: await keywordRanking(store, query, limit, candidates) },
    { source: "vector", rids: await vectorRanking(store, query, limit, candidates) },
    { source: "graph", rids: graphRanking(nodes) },
  ];

  const fused = hybridRecall(rankings);
  const hits: GraphRecallHit[] = [];
  for (const entry of fused) {
    const node = candidates.get(entry.rid);
    if (!node) continue;
    hits.push({
      id: String(node.rid),
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      score: entry.score,
      excerpt: node.excerpt,
    });
    if (hits.length >= limit) break;
  }

  return { hits, diagnostics };
}

async function keywordRanking(
  store: RecallStore,
  query: string,
  limit: number,
  candidates: Map<number, RecalledNode>,
): Promise<number[]> {
  try {
    const rows = await store.searchText(query, limit * 4);
    const seen = new Set<number>();
    const out: number[] = [];
    for (const row of rows) {
      if (!candidates.has(row.rid) || seen.has(row.rid)) continue;
      seen.add(row.rid);
      out.push(row.rid);
    }
    return out;
  } catch {
    return [];
  }
}

async function vectorRanking(
  store: RecallStore,
  query: string,
  limit: number,
  candidates: Map<number, RecalledNode>,
): Promise<number[]> {
  if (!store.searchVector) return [];
  try {
    const rows = await store.searchVector(query, limit * 4);
    const seen = new Set<number>();
    const out: number[] = [];
    for (const row of rows) {
      if (!candidates.has(row.rid) || seen.has(row.rid)) continue;
      seen.add(row.rid);
      out.push(row.rid);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Graph-distance ranking: order every engine candidate by hop depth (seeds
 * first, then 1-hop expansions, then 2-hop, …). Within a depth bucket, the
 * engine's composite score breaks ties so the higher-priority node ranks
 * better in this axis. Covers the full candidate set, which guarantees RRF
 * never drops a node the engine surfaced.
 */
function graphRanking(nodes: RecalledNode[]): number[] {
  const ordered = [...nodes].sort((a, b) => {
    const da = a.depth ?? 0;
    const db = b.depth ?? 0;
    if (da !== db) return da - db;
    if (b.score !== a.score) return b.score - a.score;
    return a.rid - b.rid;
  });
  return ordered.map((n) => n.rid);
}
