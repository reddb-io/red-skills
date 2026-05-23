import type {
  AskCost,
  GraphRow,
  MemoryStore,
  SearchRow,
  ShortestPathResult,
  StoredNode,
} from "./graph-store.js";
import { tokenize } from "./recall.js";
import {
  type Confidence,
  DEFAULT_IMPORTANCE,
  type MemoryNodeProps,
  type MemoryScope,
  type NodeType,
  type Tier,
} from "./schema.js";

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
  /**
   * Safe scope filter. Defaults to broad project recall, which includes
   * user/project/unscoped facts and hides narrower repo/branch/worktree/session
   * and agent-run facts unless the caller requests a matching scope.
   */
  scope?: RecallScope;
  /** Injectable clock for deterministic recency scoring in tests. */
  now?: number;
}

export interface RecallScope {
  /** Broadest scope the caller considers applicable for this query. */
  level: MemoryScope;
  /** Optional exact identifier for the selected scope. */
  id?: string;
  /** Include narrower scope classes too; opt-in for broad project/repo recalls. */
  includeNarrower?: boolean;
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
  status: "answered" | "insufficient-evidence" | "provider-unavailable";
  /** Grounded answer, when an LLM key is configured; null otherwise. */
  answer: string | null;
  citations: { marker: number; urn: string }[];
  /** Per-call usage and billing metadata; null when ASK is unavailable. */
  cost: AskCost | null;
  /** False when the engine has no LLM key — recall stays zero-token regardless. */
  available: boolean;
  evidence: AskEvidenceSummary;
  error?: string;
}

export interface AskEvidence {
  citation: string;
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  excerpt: string;
  confidence: Confidence;
  source: string | null;
  status: "active" | "superseded";
  activeRid: number;
}

export interface AskContradiction {
  from: AskEvidence;
  to: AskEvidence;
  reason: string | null;
  resolved: boolean;
  activeRid: number | null;
}

export interface AskEvidenceSummary {
  active: AskEvidence[];
  superseded: AskEvidence[];
  contradictory: AskContradiction[];
  byConfidence: Record<Confidence, AskEvidence[]>;
}

const SEED_NEIGHBOR_DECAY = 0.5;
const DEFAULT_RECALL_SCOPE: RecallScope = { level: "project" };
const SCOPE_RANK: Record<MemoryScope, number> = {
  user: 0,
  project: 1,
  repo: 2,
  branch: 3,
  worktree: 4,
  session: 5,
  "agent-run": 6,
};

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

function nodeScope(node: StoredNode): MemoryScope {
  return node.properties.scope ?? "project";
}

function nodeMatchesScope(node: StoredNode, scope: RecallScope): boolean {
  const memoryScope = nodeScope(node);
  const memoryRank = SCOPE_RANK[memoryScope];
  const queryRank = SCOPE_RANK[scope.level];
  if (scope.id) {
    if (memoryScope === scope.level) return node.properties.scope_id === scope.id;
    return scope.includeNarrower === true && memoryRank > queryRank;
  }
  const isAncestorOrSelf = memoryRank <= queryRank;
  const isExplicitNarrower = scope.includeNarrower === true && memoryRank > queryRank;
  if (!isAncestorOrSelf && !isExplicitNarrower) return false;

  return true;
}

/** Load every node once into an rid→node map; the read paths share it so they
 *  resolve graph-walk rids and FTS hits without rescanning. */
async function loadIndex(
  store: RecallStore,
  scope: RecallScope = DEFAULT_RECALL_SCOPE,
): Promise<Map<number, StoredNode>> {
  const index = new Map<number, StoredNode>();
  for (const node of await store.listNodes()) {
    if (nodeMatchesScope(node, scope)) index.set(node.rid, node);
  }
  return index;
}

/** Most recent timestamp recorded on a node, for recency scoring. */
function latestTimestamp(node: StoredNode): number {
  const p = node.properties;
  return Math.max(p.accessed_at ?? 0, p.updated_at ?? 0, p.created_at ?? 0);
}

interface GraphIndex {
  degree: Map<number, number>;
  maxDegree: number;
  neighbors: Map<number, number[]>;
}

/**
 * In-memory graph snapshot keyed by rid, built from one `listEdges` scan. Each
 * edge contributes both centrality and undirected recall expansion, avoiding a
 * graph-walk query per seed on the recall hot path.
 */
function graphIndex(edges: Record<string, unknown>[]): GraphIndex {
  const degree = new Map<number, number>();
  const neighbors = new Map<number, number[]>();
  const bump = (rid: number) => {
    if (Number.isFinite(rid)) degree.set(rid, (degree.get(rid) ?? 0) + 1);
  };
  const link = (from: number, to: number) => {
    if (!Number.isFinite(from) || !Number.isFinite(to)) return;
    const list = neighbors.get(from) ?? [];
    list.push(to);
    neighbors.set(from, list);
  };
  for (const e of edges) {
    const from = Number(
      e.from ?? e.from_id ?? e.from_rid ?? e.source ?? e.FROM ?? Number.NaN,
    );
    const to = Number(e.to ?? e.to_id ?? e.to_rid ?? e.target ?? e.TO ?? Number.NaN);
    bump(from);
    bump(to);
    link(from, to);
    link(to, from);
  }
  let maxDegree = 0;
  for (const d of degree.values()) if (d > maxDegree) maxDegree = d;
  return { degree, maxDegree, neighbors };
}

function expandSeedFromEdges(
  seedRid: number,
  seedScore: number,
  depth: number,
  graph: GraphIndex,
  index: Map<number, StoredNode>,
  scored: Map<number, number>,
  depthOf: Map<number, number>,
): void {
  const seen = new Set<number>([seedRid]);
  let frontier = [seedRid];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const rid of frontier) {
      for (const neighborRid of graph.neighbors.get(rid) ?? []) {
        if (seen.has(neighborRid) || !index.has(neighborRid)) continue;
        seen.add(neighborRid);
        next.push(neighborRid);
        if (!scored.has(neighborRid)) {
          scored.set(neighborRid, seedScore * SEED_NEIGHBOR_DECAY);
          depthOf.set(neighborRid, hop);
        }
      }
    }
    frontier = next;
  }
}

function resolveSupersessionHead(
  rid: number,
  supersededMap: Map<number, number>,
  index: Map<number, StoredNode>,
): number {
  const seen = new Set<number>([rid]);
  let current = rid;
  while (true) {
    const next = supersededMap.get(current);
    if (next == null || seen.has(next) || !index.has(next)) return current;
    seen.add(next);
    current = next;
  }
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
  const {
    k = 8,
    depth = 1,
    types,
    includeSuperseded = false,
    scope = DEFAULT_RECALL_SCOPE,
    now = Date.now(),
  } = opts;
  const terms = tokenize(query);
  const index = await loadIndex(store, scope);
  if (terms.length === 0) return { query, nodes: [], context_md: renderContext(query, []) };

  // Seed scores from a client-side term scan — deterministic and covers every
  // text field (title/summary/content/tags), independent of what the engine FTS
  // index happens to cover.
  const scored = new Map<number, number>();
  for (const node of index.values()) {
    const s = termScore(node, terms);
    if (s > 0) scored.set(node.rid, s);
  }

  // Engine FTS widens sparse seed sets. When the deterministic scan already
  // found enough seeds to expand, skip the extra engine query on the hot path.
  if (scored.size < k) {
    for (const hit of await store.searchText(query, k * 4)) {
      if (index.has(hit.rid) && !scored.has(hit.rid)) scored.set(hit.rid, SEED_NEIGHBOR_DECAY);
    }
  }

  // Expand the top-k seeds by `depth` hops. A neighbor inherits a decayed share
  // of the seed's score and remembers its hop distance.
  const seeds = [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, k);
  const depthOf = new Map<number, number>();
  for (const [rid] of seeds) depthOf.set(rid, 0);

  // One edge scan serves both neighborhood expansion and centrality. The engine
  // graph-walk primitive remains exposed via `neighbors`/`traverse`, but recall
  // avoids N seed-level round-trips on the hot path.
  const graph = graphIndex(await store.listEdges());

  if (depth > 0) {
    for (const [rid, score] of seeds) {
      if (index.has(rid)) expandSeedFromEdges(rid, score, depth, graph, index, scored, depthOf);
    }
  }

  // Centrality normalizes per-graph.
  const { degree, maxDegree } = graph;
  // Head-of-chain markers for every candidate in one round-trip (issue #72).
  const supersededMap = await store.supersededByMany([...index.keys()]);
  promoteSupersessionHeads(scored, depthOf, index, supersededMap);

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

function promoteSupersessionHeads(
  scored: Map<number, number>,
  depthOf: Map<number, number>,
  index: Map<number, StoredNode>,
  supersededMap: Map<number, number>,
): void {
  const original = [...scored.entries()];
  if (original.length === 0 || supersededMap.size === 0) return;

  for (const [rid, score] of original) {
    const head = resolveSupersessionHead(rid, supersededMap, index);
    if (head === rid || !index.has(head)) continue;
    const existingScore = scored.get(head) ?? 0;
    scored.set(head, Math.max(existingScore, score));
    const oldDepth = depthOf.get(rid) ?? 0;
    const existingDepth = depthOf.get(head);
    depthOf.set(head, existingDepth == null ? oldDepth : Math.min(existingDepth, oldDepth));
  }
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
  scope: RecallScope = DEFAULT_RECALL_SCOPE,
): Promise<RecalledNode[]> {
  const index = await loadIndex(store, scope);
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
  const index = await loadIndex(store, { level: "project", includeNarrower: true });
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
  const index = await loadIndex(store, { level: "project", includeNarrower: true });
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
  const recalled = await recall(store, question, { includeSuperseded: true, depth: 0, k: 8 });
  const evidence = await buildAskEvidence(store, recalled.nodes);
  const citations = [...evidence.active, ...evidence.superseded].map((item) => ({
    marker: Number(item.citation.replace(/\D/g, "")),
    urn: `memory_nodes:${item.rid}`,
  }));

  if (evidence.active.length === 0 && evidence.superseded.length === 0) {
    return {
      question,
      status: "insufficient-evidence",
      answer: "Insufficient evidence in Memory to answer this question.",
      citations: [],
      cost: null,
      available: true,
      evidence,
    };
  }

  try {
    const { answer, cost } = await store.ask(askPrompt(question, evidence));
    return {
      question,
      status: "answered",
      answer,
      citations,
      cost,
      available: true,
      evidence,
    };
  } catch (err) {
    return {
      question,
      status: "provider-unavailable",
      answer: null,
      citations,
      cost: null,
      available: false,
      evidence,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function buildAskEvidence(
  store: MemoryStore,
  nodes: RecalledNode[],
): Promise<AskEvidenceSummary> {
  const rids = nodes.map((node) => node.rid);
  const superseded = await store.supersededByMany(rids);
  const nodeEvidence = nodes.map((node, index) => toAskEvidence(node, index + 1, superseded));
  const byRid = new Map(nodeEvidence.map((item) => [item.rid, item]));
  const contradictory: AskContradiction[] = [];

  for (const edge of await store.listEdges()) {
    if (edgeLabel(edge) !== "CONTRADICTS") continue;
    const from = byRid.get(edgeFrom(edge));
    const to = byRid.get(edgeTo(edge));
    if (!from || !to) continue;
    const resolved = from.activeRid === to.activeRid;
    contradictory.push({
      from,
      to,
      reason: edgeReason(edge),
      resolved,
      activeRid: resolved ? from.activeRid : null,
    });
  }

  return {
    active: nodeEvidence.filter((item) => item.status === "active"),
    superseded: nodeEvidence.filter((item) => item.status === "superseded"),
    contradictory,
    byConfidence: evidenceByConfidence(nodeEvidence),
  };
}

function evidenceByConfidence(items: AskEvidence[]): Record<Confidence, AskEvidence[]> {
  return {
    EXTRACTED: items.filter((item) => item.confidence === "EXTRACTED"),
    INFERRED: items.filter((item) => item.confidence === "INFERRED"),
    AMBIGUOUS: items.filter((item) => item.confidence === "AMBIGUOUS"),
  };
}

function toAskEvidence(
  node: RecalledNode,
  marker: number,
  superseded: Map<number, number>,
): AskEvidence {
  const activeRid = activeHead(node.rid, superseded);
  return {
    citation: `[${marker}]`,
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: node.properties.title ?? node.label,
    excerpt: node.excerpt,
    confidence: node.properties.confidence ?? "AMBIGUOUS",
    source: typeof node.properties.source === "string" ? node.properties.source : null,
    status: activeRid === node.rid ? "active" : "superseded",
    activeRid,
  };
}

function askPrompt(question: string, evidence: AskEvidenceSummary): string {
  return [
    "Answer the question using only the Memory evidence below.",
    "Cite every substantive claim with the evidence marker, for example [1].",
    "If the evidence does not support an answer, reply with: Insufficient evidence.",
    "Call out contradictions and superseded evidence when relevant.",
    "",
    `Question: ${question}`,
    "",
    "Active evidence:",
    ...renderAskEvidence(evidence.active),
    "",
    "Superseded evidence:",
    ...renderAskEvidence(evidence.superseded),
    "",
    "Contradictions:",
    ...renderAskContradictions(evidence.contradictory),
  ].join("\n");
}

function renderAskEvidence(items: AskEvidence[]): string[] {
  if (items.length === 0) return ["(none)"];
  return items.map((item) => {
    const source = item.source ? ` source=${item.source}` : "";
    return `${item.citation} ${item.title} (${item.confidence}; rid=${item.rid}; ${item.status}${source}) ${item.excerpt}`;
  });
}

function renderAskContradictions(items: AskContradiction[]): string[] {
  if (items.length === 0) return ["(none)"];
  return items.map((item) => {
    const state = item.resolved ? `resolved active=${item.activeRid}` : "unresolved";
    const reason = item.reason ? ` reason=${item.reason}` : "";
    return `${item.from.citation} contradicts ${item.to.citation} (${state}${reason})`;
  });
}

function activeHead(rid: number, superseded: Map<number, number>): number {
  const seen = new Set<number>();
  let current = rid;
  while (!seen.has(current)) {
    seen.add(current);
    const next = superseded.get(current);
    if (next == null) return current;
    current = next;
  }
  return current;
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? "");
}

function edgeFrom(edge: Record<string, unknown>): number {
  return Number(edge.from_rid ?? edge.from ?? edge.from_id ?? edge.source ?? edge.source_id);
}

function edgeTo(edge: Record<string, unknown>): number {
  return Number(edge.to_rid ?? edge.to ?? edge.to_id ?? edge.target ?? edge.target_id);
}

function edgeReason(edge: Record<string, unknown>): string | null {
  const props = edge.properties;
  if (props && typeof props === "object" && "reason" in props) {
    const reason = (props as { reason?: unknown }).reason;
    return reason == null ? null : String(reason);
  }
  return null;
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
