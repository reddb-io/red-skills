import {
  recall,
  type RecalledNode,
  type RecallDiagnostics,
  type RecallScope,
  type RecallStore,
} from "./engine.js";
import {
  loadEngineeringCodeCuration,
  resolveEngineeringCodeAlias,
} from "./code-curation.js";
import { normalizeEngineeringCode } from "./extraction-schema.js";
import type { MemoryStore } from "./graph-store.js";
import { hybridRecall, type Ranking } from "./hybrid-recall.js";
import { appendEngineOpEvent } from "./memory-events.js";

/** One Envelope user-hook execution surfaced on an attempt hit (issue #216). */
export interface GraphRecallHookEntry {
  lifecycle: string;
  command: string;
  exit_code: number;
}

export interface GraphRecallHit {
  /** Engine-assigned node rid, as a string for uniform CLI printing. */
  id: string;
  rid: number;
  label: string;
  node_type: string;
  score: number;
  excerpt: string;
  /**
   * User-hook executions from the Envelope `hooks` section (issue #216).
   * Only set when the underlying node carries a non-empty `hooks` property
   * (today: `attempt` nodes recorded after the AFK terminal envelope).
   */
  hooks?: GraphRecallHookEntry[];
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
  const codeCanonicalize = await loadCodeCanonicalizer(store);
  const { nodes, diagnostics } = await recall(store, query, {
    k: limit,
    depth: 1,
    includeSuperseded: opts.includeSuperseded,
    scope: opts.scope,
    now: opts.now,
    codeCanonicalize,
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
    const hooks = extractHookEntries(node.properties.hooks);
    hits.push({
      id: String(node.rid),
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      score: entry.score,
      excerpt: node.excerpt,
      ...(hooks ? { hooks } : {}),
    });
    if (hits.length >= limit) break;
  }

  return { hits, diagnostics };
}

async function loadCodeCanonicalizer(store: RecallStore): Promise<(code: string) => string> {
  if (!isMemoryStore(store)) return normalizeEngineeringCode;
  const curation = await loadEngineeringCodeCuration(store).catch(() => null);
  return curation
    ? (code: string) => resolveEngineeringCodeAlias(code, curation)
    : normalizeEngineeringCode;
}

function extractHookEntries(raw: unknown): GraphRecallHookEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: GraphRecallHookEntry[] = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const lifecycle = typeof entry.lifecycle === "string" ? entry.lifecycle : "";
    const command = typeof entry.command === "string" ? entry.command : "";
    const exit = entry.exit_code;
    const exit_code =
      typeof exit === "number" && Number.isFinite(exit)
        ? exit
        : typeof exit === "string" && /^-?\d+$/.test(exit.trim())
          ? Number(exit.trim())
          : NaN;
    if (!lifecycle || !command || !Number.isFinite(exit_code)) continue;
    out.push({ lifecycle, command, exit_code });
  }
  return out.length > 0 ? out : null;
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
