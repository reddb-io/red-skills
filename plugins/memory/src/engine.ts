import type { GraphRow, MemoryStore, ShortestPathResult, StoredNode } from "./graph-store.js";
import { tokenize } from "./recall.js";
import type { MemoryNodeProps, NodeType } from "./schema.js";

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
async function loadIndex(store: MemoryStore): Promise<Map<number, StoredNode>> {
  const index = new Map<number, StoredNode>();
  for (const node of await store.listNodes()) index.set(node.rid, node);
  return index;
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
  store: MemoryStore,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const { k = 8, depth = 1, types } = opts;
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

  const nodes: RecalledNode[] = [];
  for (const [rid, score] of scored) {
    // Head-of-chain default: a superseded node is hidden behind its successor.
    if ((await store.supersededBy(rid)) != null) continue;
    const node = index.get(rid);
    if (!node) continue;
    if (types && types.length > 0 && !types.includes(node.node_type)) continue;
    nodes.push(toRecalled(node, score, depthOf.get(rid)));
  }

  nodes.sort((a, b) => b.score - a.score || a.rid - b.rid);
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
