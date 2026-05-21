import type { GraphRow, MemoryStore, SearchRow, ShortestPathResult, StoredNode } from "./graph-store.js";
import { tokenize } from "./recall.js";
import { DEFAULT_IMPORTANCE, type MemoryNodeProps, type NodeType, type Tier } from "./schema.js";

/**
 * Recall engine — the zero-token read path over the memory graph.
 *
 * `recall` is hybrid: full-text seeds (engine `SEARCH TEXT`, widened by a
 * client-side term scan so coverage is deterministic) are expanded one or more
 * graph hops, superseded nodes are dropped (head-of-`SUPERSEDED_BY`-chain), and
 * the result is ranked and rendered to a markdown context block ready to inject
 * into an agent's prompt. None of this calls an LLM — only `ask` does.
 *
 * The other verbs (`search`, `neighbors`, `traverse`, `path`) expose the
 * underlying primitives directly for agents that want to drive the graph
 * themselves; they share the rid→node resolution so callers get full nodes back
 * rather than the engine's bare graph rows.
 */

/** A node returned by the engine, scored and (for graph walks) depth-tagged. */
export interface RecalledNode {
  rid: number;
  label: string;
  node_type: NodeType;
  score: number;
  /** Hops from the seed/start node, when the result came from a graph walk. */
  depth?: number;
  properties: MemoryNodeProps;
  excerpt: string;
}

export interface RecallResult {
  query: string;
  nodes: RecalledNode[];
  /** Markdown block ready to inject into a system note. */
  context_md: string;
}

export interface RecallOptions {
  /** Number of FTS seeds to expand from (default 8). */
  k?: number;
  /** Graph hops to expand each seed (default 1, 0 disables expansion). */
  depth?: number;
  /** Restrict results to these node types. */
  types?: string[];
  /**
   * Return the full `SUPERSEDED_BY` chain instead of just its head. Default
   * `false`: a superseded node is hidden behind its successor (issue #72 /
   * PRD #49).
   */
  includeSuperseded?: boolean;
  /** Injectable clock for deterministic recency scoring in tests. */
  now?: number;
}

/**
 * The structural slice of `MemoryStore` the recall engine reads. Typing recall
 * against this (rather than the concrete store) lets unit tests drive ranking
 * with an in-memory mock; the real `MemoryStore` satisfies it.
 */
export interface RecallStore {
  listNodes(now?: number): Promise<StoredNode[]>;
  searchText(query: string, limit?: number): Promise<SearchRow[]>;
  neighborhood(
    label: string,
    depth?: number,
    direction?: "outgoing" | "incoming" | "both",
  ): Promise<GraphRow[]>;
  supersededByMany(rids: number[]): Promise<Map<number, number>>;
  recordAccess(rids: number[]): Promise<void>;
  listEdges(): Promise<Record<string, unknown>[]>;
}

/**
 * Tier-weight multiplier for recall ranking (issue #72). Durable decisions
 * outrank reasoning traces, which outrank ephemeral session noise — so for two
 * otherwise-comparable nodes the more durable one surfaces first.
 */
export const TIER_WEIGHT: Record<Tier, number> = {
  durable: 1.0,
  reasoning: 0.7,
  ephemeral: 0.4,
};

/** Recency half-life: a node's recency factor halves every 30 days of age. */
export const RECENCY_HALF_LIFE_MS = 30 * 86_400_000;

/** Inputs to the composite recall score, one per candidate node. */
export interface RankInputs {
  /** Base query-match signal (term overlap, neighbor-decayed). */
  relevance: number;
  /** Node importance in [0, 1]. */
  importance: number;
  tier: Tier;
  /** Age in ms of the node's most recent timestamp; clamped to ≥ 0. */
  ageMs: number;
  /** Incident edge count of the node. */
  degree: number;
  /** Max incident edge count across the graph (normalizes centrality). */
  maxDegree: number;
}

/**
 * Composite recall score: `relevance × importance × recency × centrality ×
 * tier-weight` (issue #72). Relevance keeps a direct text match ahead of a
 * graph-only neighbor; the remaining factors order *comparable* nodes — newer,
 * more central, more durable nodes float up. Every factor is in (0, 1] except
 * relevance, so it stays the dominant signal.
 */
export function rankScore(i: RankInputs): number {
  const recency = 0.5 ** (Math.max(0, i.ageMs) / RECENCY_HALF_LIFE_MS);
  const centrality = (i.degree + 1) / (i.maxDegree + 1);
  return i.relevance * i.importance * recency * centrality * TIER_WEIGHT[i.tier];
}

export interface AskResult {
  question: string;
  /** Grounded answer, when an LLM key is configured; null otherwise. */
  answer: string | null;
  citations: { marker: number; urn: string }[];
  /** False when the engine has no LLM key — recall stays zero-token regardless. */
  available: boolean;
  error?: string;
}

const SEED_NEIGHBOR_DECAY = 0.5;

/** The text fields of a node that recall scores against. */
function nodeText(node: StoredNode): string {
  const p = node.properties;
  const tags = Array.isArray(p.tags) ? p.tags.join(" ") : "";
  return [node.label, p.title, p.summary, p.content, tags].filter(Boolean).join(" ");
}

function excerptOf(node: StoredNode): string {
  const p = node.properties;
  return (p.summary ?? p.content ?? p.title ?? node.label).slice(0, 200);
}

function toRecalled(node: StoredNode, score: number, depth?: number): RecalledNode {
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    score,
    depth,
    properties: node.properties,
    excerpt: excerptOf(node),
  };
}

/** Load every node once into an rid→node map; the read paths share it so they
 *  resolve graph-walk rids and FTS hits without rescanning. */
async function loadIndex(store: RecallStore): Promise<Map<number, StoredNode>> {
  const index = new Map<number, StoredNode>();
  for (const node of await store.listNodes()) index.set(node.rid, node);
  return index;
}

/** Most recent timestamp recorded on a node, for recency scoring. */
function latestTimestamp(node: StoredNode): number {
  const p = node.properties;
  return Math.max(p.accessed_at ?? 0, p.updated_at ?? 0, p.created_at ?? 0);
}

/**
 * Degree map keyed by rid, built from one `listEdges` scan. Each edge bumps the
 * degree of both endpoints (centrality is undirected here). Column names vary
 * by engine build — mirror `export.ts`'s edge normalizer.
 */
function degreeIndex(edges: Record<string, unknown>[]): {
  degree: Map<number, number>;
  maxDegree: number;
} {
  const degree = new Map<number, number>();
  const bump = (rid: number) => {
    if (Number.isFinite(rid)) degree.set(rid, (degree.get(rid) ?? 0) + 1);
  };
  for (const e of edges) {
    bump(Number(e.from ?? e.from_id ?? e.source ?? e.FROM ?? Number.NaN));
    bump(Number(e.to ?? e.to_id ?? e.target ?? e.TO ?? Number.NaN));
  }
  let maxDegree = 0;
  for (const d of degree.values()) if (d > maxDegree) maxDegree = d;
  return { degree, maxDegree };
}

/** Token-overlap score: how many distinct query terms appear in the node. */
function termScore(node: StoredNode, terms: string[]): number {
  let score = 0;
  const seen = new Set<string>();
  for (const token of tokenize(nodeText(node))) {
    if (terms.includes(token) && !seen.has(token)) {
      seen.add(token);
      score += 1;
    }
  }
  return score;
}

/**
 * Hybrid recall: FTS + client-side term seeds → graph-neighborhood expansion →
 * ranked nodes + markdown context. Superseded nodes are hidden behind their
 * successor. Returns the full ranked set (seeds + neighbors); callers cap it.
 */
export async function recall(
  store: RecallStore,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const { k = 8, depth = 1, types, includeSuperseded = false, now = Date.now() } = opts;
  const terms = tokenize(query);
  const index = await loadIndex(store);
  if (terms.length === 0) return { query, nodes: [], context_md: renderContext(query, []) };

  // Seed scores from a client-side term scan — deterministic and covers every
  // text field (title/summary/content/tags), independent of what the engine FTS
  // index happens to cover.
  const scored = new Map<number, number>();
  for (const node of index.values()) {
    const s = termScore(node, terms);
    if (s > 0) scored.set(node.rid, s);
  }

  // Engine FTS widens the seed set. An FTS-only hit (no term-scan score) gets a
  // weak base score so direct term matches always outrank it.
  for (const hit of await store.searchText(query, k * 4)) {
    if (index.has(hit.rid) && !scored.has(hit.rid)) scored.set(hit.rid, SEED_NEIGHBOR_DECAY);
  }

  // Expand the top-k seeds by `depth` hops. A neighbor inherits a decayed share
  // of the seed's score and remembers its hop distance.
  const seeds = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k);
  const depthOf = new Map<number, number>();
  for (const [rid] of seeds) depthOf.set(rid, 0);

  if (depth > 0) {
    for (const [rid, score] of seeds) {
      const seed = index.get(rid);
      if (!seed) continue;
      for (const neighbor of await store.neighborhood(seed.label, depth, "both")) {
        if (!index.has(neighbor.rid) || scored.has(neighbor.rid)) continue;
        scored.set(neighbor.rid, score * SEED_NEIGHBOR_DECAY);
        depthOf.set(neighbor.rid, neighbor.depth);
      }
    }
  }

  // Centrality needs the whole edge set once; degree normalizes per-graph.
  const { degree, maxDegree } = degreeIndex(await store.listEdges());
  // Head-of-chain markers for every candidate in one round-trip (issue #72).
  const supersededMap = includeSuperseded
    ? new Map<number, number>()
    : await store.supersededByMany([...scored.keys()]);

  const nodes: RecalledNode[] = [];
  for (const [rid, relevance] of scored) {
    // Head-of-chain default: a superseded node is hidden behind its successor
    // unless the caller asked for the full chain (`--include-superseded`).
    if (!includeSuperseded && supersededMap.get(rid) != null) continue;
    const node = index.get(rid);
    if (!node) continue;
    if (types && types.length > 0 && !types.includes(node.node_type)) continue;
    // Tier-aware composite score: relevance keeps the strongest text match on
    // top; importance/recency/centrality/tier-weight order comparable nodes.
    const score = rankScore({
      relevance,
      importance: node.properties.importance ?? DEFAULT_IMPORTANCE,
      tier: node.properties.tier ?? "durable",
      ageMs: now - latestTimestamp(node),
      degree: degree.get(rid) ?? 0,
      maxDegree,
    });
    nodes.push(toRecalled(node, score, depthOf.get(rid)));
  }

  nodes.sort((a, b) => b.score - a.score || a.rid - b.rid);

  // Decay bookkeeping: a recalled node is a used node. Bump its access overlay
  // (count + last-accessed) so `memory:doctor` can tell what's still earning its
  // keep from what's gone cold. Best-effort — never let it fail a read.
  if (nodes.length > 0) {
    await store.recordAccess(nodes.map((n) => n.rid)).catch(() => {});
  }

  return { query, nodes, context_md: renderContext(query, nodes) };
}

/**
 * Direct full-text search over node titles + content. Merges two signals: a
 * client-side term scan (deterministic, covers every text field including
 * `content`) and the engine's `SEARCH TEXT` (covers label/title, contributes
 * its own ranking). A node matched by either surfaces; term-scan matches rank
 * above FTS-only matches.
 */
export async function search(
  store: MemoryStore,
  query: string,
  limit = 20,
): Promise<RecalledNode[]> {
  const index = await loadIndex(store);
  const terms = tokenize(query);
  const scored = new Map<number, number>();

  if (terms.length > 0) {
    for (const node of index.values()) {
      const s = termScore(node, terms);
      if (s > 0) scored.set(node.rid, s);
    }
  }
  for (const hit of await store.searchText(query, limit)) {
    if (index.has(hit.rid) && !scored.has(hit.rid)) scored.set(hit.rid, SEED_NEIGHBOR_DECAY);
  }

  const out: RecalledNode[] = [];
  for (const [rid, score] of scored) {
    const node = index.get(rid);
    if (node) out.push(toRecalled(node, score));
  }
  out.sort((a, b) => b.score - a.score || a.rid - b.rid);
  return out.slice(0, limit);
}

/** Resolve graph-walk rows (neighborhood/traverse) to full nodes, depth-tagged
 *  and scored by closeness (a hop-0 node scores 1, hop-1 scores 0.5, …). */
function resolveWalk(rows: GraphRow[], index: Map<number, StoredNode>): RecalledNode[] {
  const out: RecalledNode[] = [];
  for (const row of rows) {
    const node = index.get(row.rid);
    if (node) out.push(toRecalled(node, 1 / (1 + row.depth), row.depth));
  }
  out.sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0) || a.rid - b.rid);
  return out;
}

/** One-or-more-hop neighborhood around a node label, resolved to full nodes. */
export async function neighbors(
  store: MemoryStore,
  label: string,
  depth = 1,
  direction: "outgoing" | "incoming" | "both" = "both",
): Promise<RecalledNode[]> {
  const index = await loadIndex(store);
  return resolveWalk(await store.neighborhood(label, depth, direction), index);
}

/** BFS/DFS traversal from a node label, resolved to full nodes. */
export async function traverse(
  store: MemoryStore,
  start: string,
  opts: {
    depth?: number;
    strategy?: "bfs" | "dfs";
    direction?: "outgoing" | "incoming" | "both";
  } = {},
): Promise<RecalledNode[]> {
  const index = await loadIndex(store);
  return resolveWalk(await store.traverse(start, opts), index);
}

/** Shortest path between two node labels. */
export async function path(
  store: MemoryStore,
  from: string,
  to: string,
  algorithm: "bfs" | "dijkstra" = "bfs",
): Promise<ShortestPathResult | null> {
  return store.shortestPath(from, to, algorithm);
}

/** Grounded ASK over the document collection. Degrades gracefully when the
 *  engine has no LLM key — the rest of the engine stays zero-token. */
export async function ask(store: MemoryStore, question: string): Promise<AskResult> {
  try {
    const { answer, citations } = await store.ask(question);
    return { question, answer, citations, available: true };
  } catch (err) {
    return {
      question,
      answer: null,
      citations: [],
      available: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function renderContext(query: string, nodes: RecalledNode[]): string {
  if (nodes.length === 0) return `# Memory recall: ${query}\n\n_(no relevant memory)_\n`;
  const lines = [`# Memory recall: ${query}`, ""];
  for (const n of nodes.slice(0, 12)) {
    const p = n.properties;
    const source = p.source ? ` — ${p.source}` : "";
    lines.push(`- **${p.title ?? n.label}** _(${n.node_type})_${source}`);
    const detail = p.summary ?? p.content;
    if (detail) lines.push(`  ${detail.slice(0, 200)}`);
  }
  return `${lines.join("\n")}\n`;
}
