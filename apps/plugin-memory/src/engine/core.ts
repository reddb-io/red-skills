import {
  pathConfidence as pathConfidenceWeakestLink,
  scoreConfidence,
  type ConfidenceBreakdown,
  type ConfidenceSignals,
  type SupersessionStatus,
} from "../confidence-scoring.js";
import type { GraphRow, MemoryStore, ShortestPathResult, StoredNode } from "../graph-store.js";
import { normalizeEngineeringCode } from "../extraction-schema.js";
import { tokenize } from "../recall.js";
import { DEFAULT_IMPORTANCE, type Confidence, type MemoryScope } from "../schema.js";
import {
  PROVENANCE_TIER_WEIGHT,
  RECENCY_HALF_LIFE_MS,
  TIER_WEIGHT,
  TRUST_WEIGHT,
  rankScore,
  type AskCitation,
  type AskContradiction,
  type AskEvidence,
  type AskEvidenceSummary,
  type AskFederationHit,
  type AskGapAnalysis,
  type AskResult,
  type RecallDiagnostics,
  type RecalledNode,
  type RecallOptions,
  type RecallResult,
  type RecallScope,
  type RecallStore,
  type VectorRecallDiagnostics,
} from "./types.js";

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

const SEED_NEIGHBOR_DECAY = 0.5;
const VECTOR_SEED_WEIGHT = 0.5;
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
function nodeText(node: StoredNode, codeCanonicalize: (code: string) => string = normalizeEngineeringCode): string {
  const p = node.properties;
  const tags = Array.isArray(p.tags) ? p.tags.join(" ") : "";
  const code = typeof p.engineering_code === "string" ? normalizeEngineeringCode(p.engineering_code) : "";
  const canonicalCode = code ? codeCanonicalize(code) : "";
  return [node.label, p.title, p.summary, p.content, tags, code, canonicalCode]
    .filter(Boolean)
    .join(" ");
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
  now?: number,
): Promise<Map<number, StoredNode>> {
  const index = new Map<number, StoredNode>();
  for (const node of await store.listNodes(now)) {
    if (nodeMatchesScope(node, scope)) index.set(node.rid, node);
  }
  return index;
}

/** Most recent timestamp recorded on a node, for recency scoring. */
function latestTimestamp(node: StoredNode): number {
  const p = node.properties;
  return Math.max(p.accessed_at ?? 0, p.updated_at ?? 0, p.created_at ?? 0);
}

function trustWeight(node: StoredNode): number {
  const confidence = node.properties.confidence ?? node.properties.provenance?.confidence;
  return confidence && confidence in TRUST_WEIGHT ? TRUST_WEIGHT[confidence] : 1;
}

/**
 * Shared context for the confidence composer (issue #167). Built once per
 * read so recall, neighbors, traverse, and ask all see the same supersession
 * + validation snapshot.
 */
export interface ConfidenceContext {
  now: number;
  /** rid → successor rid; presence means the node is superseded. */
  supersededMap: Map<number, number>;
  /** rids that supersede something (head-of-chain markers). */
  supersedingSet: Set<number>;
  /** rid → counts of incident CONFIRMS / CONTRADICTS edges. */
  validation: Map<number, { confirms: number; contradicts: number }>;
}

export async function buildConfidenceContext(
  store: RecallStore | MemoryStore,
  now: number = Date.now(),
): Promise<ConfidenceContext> {
  const nodes = await store.listNodes(now);
  const supersededMap = await store.supersededByMany(nodes.map((n) => n.rid));
  const supersedingSet = new Set<number>();
  for (const successor of supersededMap.values()) supersedingSet.add(successor);
  const validation = new Map<number, { confirms: number; contradicts: number }>();
  const bump = (rid: number, kind: "confirms" | "contradicts") => {
    if (!Number.isFinite(rid)) return;
    const entry = validation.get(rid) ?? { confirms: 0, contradicts: 0 };
    entry[kind] += 1;
    validation.set(rid, entry);
  };
  for (const edge of await store.listEdges()) {
    const label = edgeLabel(edge);
    if (label !== "CONFIRMS" && label !== "CONTRADICTS") continue;
    const kind = label === "CONFIRMS" ? "confirms" : "contradicts";
    bump(edgeFrom(edge), kind);
    bump(edgeTo(edge), kind);
  }
  return { now, supersededMap, supersedingSet, validation };
}

export function confidenceSignalsFor(
  node: StoredNode,
  ctx: ConfidenceContext,
): ConfidenceSignals {
  const p = node.properties;
  let provenanceDepth = 0;
  const provenance = p.provenance;
  if (provenance) {
    if (Array.isArray(provenance.evidence)) provenanceDepth = provenance.evidence.length;
    if (provenanceDepth === 0 && provenance.source_kind === "manual") provenanceDepth = 1;
  }
  if (typeof p.source === "string" && p.source.length > 0) provenanceDepth = Math.max(provenanceDepth, 1);
  const confidenceEnum = p.confidence ?? p.provenance?.confidence;
  if (confidenceEnum === "EXTRACTED") provenanceDepth = Math.max(provenanceDepth, 2);
  else if (confidenceEnum === "INFERRED") provenanceDepth = Math.max(provenanceDepth, 1);

  const ageMs = Math.max(0, ctx.now - latestTimestamp(node));
  const recency = 0.5 ** (ageMs / RECENCY_HALF_LIFE_MS);

  let supersession_status: SupersessionStatus = "active";
  if (ctx.supersededMap.has(node.rid)) supersession_status = "superseded";
  else if (ctx.supersedingSet.has(node.rid)) supersession_status = "superseding";

  const v = ctx.validation.get(node.rid);
  const totals = (v?.confirms ?? 0) + (v?.contradicts ?? 0);
  const validation_signal = totals === 0 ? 0 : ((v?.confirms ?? 0) - (v?.contradicts ?? 0)) / totals;

  return { provenance_depth: provenanceDepth, recency, supersession_status, validation_signal };
}

export function confidenceForNode(
  node: StoredNode,
  ctx: ConfidenceContext,
): ConfidenceBreakdown {
  return scoreConfidence(confidenceSignalsFor(node, ctx));
}

export function pathConfidence(nodeConfidences: readonly number[]): number | null {
  return pathConfidenceWeakestLink(nodeConfidences);
}

function recallConfidenceContext(
  now: number,
  supersededMap: Map<number, number>,
  edges: Record<string, unknown>[],
): ConfidenceContext {
  const supersedingSet = new Set<number>();
  for (const successor of supersededMap.values()) supersedingSet.add(successor);
  const validation = new Map<number, { confirms: number; contradicts: number }>();
  const bump = (rid: number, kind: "confirms" | "contradicts") => {
    if (!Number.isFinite(rid)) return;
    const entry = validation.get(rid) ?? { confirms: 0, contradicts: 0 };
    entry[kind] += 1;
    validation.set(rid, entry);
  };
  for (const edge of edges) {
    const label = edgeLabel(edge);
    if (label !== "CONFIRMS" && label !== "CONTRADICTS") continue;
    const kind = label === "CONFIRMS" ? "confirms" : "contradicts";
    bump(edgeFrom(edge), kind);
    bump(edgeTo(edge), kind);
  }
  return { now, supersededMap, supersedingSet, validation };
}

function attachConfidence(node: RecalledNode, source: StoredNode, ctx: ConfidenceContext): void {
  const breakdown = confidenceForNode(source, ctx);
  node.confidence = breakdown.confidence;
  node.confidence_breakdown = breakdown;
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
function termScore(
  node: StoredNode,
  terms: string[],
  codeCanonicalize: (code: string) => string = normalizeEngineeringCode,
): number {
  let score = 0;
  const seen = new Set<string>();
  for (const token of tokenize(nodeText(node, codeCanonicalize))) {
    if (terms.includes(token) && !seen.has(token)) {
      seen.add(token);
      score += 1;
    }
  }
  return score;
}

function emptyDiagnostics(reason?: string): RecallDiagnostics {
  return {
    vector: {
      status: "unavailable",
      candidates: 0,
      contributed: 0,
      ...(reason ? { reason } : {}),
    },
  };
}

function vectorSeedScore(score: number): number {
  if (!Number.isFinite(score)) return VECTOR_SEED_WEIGHT;
  const normalized = Math.max(0, Math.min(1, score));
  return normalized * VECTOR_SEED_WEIGHT;
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
    codes,
    codeCanonicalize = normalizeEngineeringCode,
    includeSuperseded = false,
    scope = DEFAULT_RECALL_SCOPE,
    now = Date.now(),
  } = opts;
  // Pre-normalize the engineering-code filter once (ADR 0035): the stored code is
  // already a normalized slug, so the caller's input is normalized to match.
  const codeFilter =
    codes && codes.length > 0 ? new Set(codes.map(codeCanonicalize)) : null;
  const terms = tokenize(query);
  const index = await loadIndex(store, scope, now);
  if (terms.length === 0) {
    const diagnostics = emptyDiagnostics("blank query");
    return { query, nodes: [], context_md: renderContext(query, [], diagnostics), diagnostics };
  }

  // Seed scores from a client-side term scan — deterministic and covers every
  // text field (title/summary/content/tags), independent of what the engine FTS
  // index happens to cover.
  const scored = new Map<number, number>();
  for (const node of index.values()) {
    const s = termScore(node, terms, codeCanonicalize);
    if (s > 0) scored.set(node.rid, s);
  }

  // Engine FTS widens sparse seed sets. When the deterministic scan already
  // found enough seeds to expand, skip the extra engine query on the hot path.
  if (scored.size < k) {
    for (const hit of await store.searchText(query, k * 4)) {
      if (index.has(hit.rid) && !scored.has(hit.rid)) scored.set(hit.rid, SEED_NEIGHBOR_DECAY);
    }
  }

  const diagnostics = emptyDiagnostics("vector search is not available on this store");
  if (store.searchVector) {
    try {
      const vectorHits = await store.searchVector(query, k * 4);
      diagnostics.vector = { status: "available", candidates: vectorHits.length, contributed: 0 };
      const contributed = new Set<number>();
      for (const hit of vectorHits) {
        if (!index.has(hit.rid)) continue;
        const relevance = vectorSeedScore(hit.score);
        if (relevance <= 0) continue;
        const existing = scored.get(hit.rid);
        if (existing == null || relevance > existing) {
          scored.set(hit.rid, Math.max(existing ?? 0, relevance));
          contributed.add(hit.rid);
        }
      }
      diagnostics.vector.contributed = contributed.size;
      if (contributed.size > 0) diagnostics.vector.status = "contributed";
    } catch (err) {
      diagnostics.vector = {
        status: "unavailable",
        candidates: 0,
        contributed: 0,
        reason: err instanceof Error ? err.message : String(err),
      };
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
  const edges = await store.listEdges();
  const graph = graphIndex(edges);

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

  // Confidence composition shares the recall's supersession + edge snapshot
  // so the per-node breakdown stays consistent with the rest of the result.
  const confidenceCtx = recallConfidenceContext(now, supersededMap, edges);

  const nodes: RecalledNode[] = [];
  for (const [rid, relevance] of scored) {
    // Head-of-chain default: a superseded node is hidden behind its successor
    // unless the caller asked for the full chain (`--include-superseded`).
    if (!includeSuperseded && supersededMap.get(rid) != null) continue;
    const node = index.get(rid);
    if (!node) continue;
    if (types && types.length > 0 && !types.includes(node.node_type)) continue;
    if (codeFilter) {
      const code = node.properties.engineering_code;
      if (!code || !codeFilter.has(codeCanonicalize(code))) continue;
    }
    // Tier-aware composite score: relevance keeps the strongest text match on
    // top; importance/recency/centrality/tier-weight order comparable nodes.
    const score = rankScore({
      relevance,
      importance: node.properties.importance ?? DEFAULT_IMPORTANCE,
      tier: node.properties.tier ?? "durable",
      ageMs: now - latestTimestamp(node),
      degree: degree.get(rid) ?? 0,
      maxDegree,
      trust: trustWeight(node),
      provenanceTier: node.properties.provenance_tier ?? "proxy",
    });
    const recalled = toRecalled(node, score, depthOf.get(rid));
    attachConfidence(recalled, node, confidenceCtx);
    nodes.push(recalled);
  }

  nodes.sort((a, b) => b.score - a.score || a.rid - b.rid);

  // Decay bookkeeping: a recalled node is a used node. Bump its access overlay
  // (count + last-accessed) so `memory:doctor` can tell what's still earning its
  // keep from what's gone cold. Best-effort — never let it fail a read.
  if (nodes.length > 0 && store.recordAccess) {
    await store.recordAccess(nodes.map((n) => n.rid), now).catch(() => {});
  }

  return { query, nodes, context_md: renderContext(query, nodes, diagnostics), diagnostics };
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
function resolveWalk(
  rows: GraphRow[],
  index: Map<number, StoredNode>,
  confidenceCtx?: ConfidenceContext,
): RecalledNode[] {
  const out: RecalledNode[] = [];
  for (const row of rows) {
    const node = index.get(row.rid);
    if (!node) continue;
    const recalled = toRecalled(node, 1 / (1 + row.depth), row.depth);
    if (confidenceCtx) attachConfidence(recalled, node, confidenceCtx);
    out.push(recalled);
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
  const confidenceCtx = await buildConfidenceContext(store);
  return resolveWalk(await store.neighborhood(label, depth, direction), index, confidenceCtx);
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
  const confidenceCtx = await buildConfidenceContext(store);
  return resolveWalk(await store.traverse(start, opts), index, confidenceCtx);
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
 *  engine has no LLM key — the rest of the engine stays zero-token.
 *
 *  Issue #173: when `opts.rootDir` is provided, ask additionally composes
 *  reasoning-replay (semantic gaps from past attempts), learning-debt
 *  (repeated-failure patterns), and federation (cross-root hits) into the
 *  result. All compositions are additive and read-only; on failure each
 *  composing surface degrades to its empty form so the core ASK keeps working.
 */
export async function ask(
  store: MemoryStore,
  question: string,
  opts: { rootDir?: string; now?: number } = {},
): Promise<AskResult> {
  const recalled = await recall(store, question, {
    includeSuperseded: true,
    depth: 0,
    k: 8,
    now: opts.now,
  });
  const evidence = await buildAskEvidence(store, recalled.nodes);
  const gapAnalysis = buildAskGapAnalysis(evidence);
  const citations: AskCitation[] = [...evidence.active, ...evidence.superseded].map((item) => ({
    marker: Number(item.citation.replace(/\D/g, "")),
    urn: `memory_nodes:${item.rid}`,
    confidence: item.confidence_score ?? null,
  }));
  const whatIDontKnow = await composeWhatIDontKnow(store, question, gapAnalysis, opts.now);
  const federationHits = await composeFederationHits(question, opts.rootDir, opts.now);

  if (evidence.active.length === 0 && evidence.superseded.length === 0) {
    return {
      question,
      status: "insufficient-evidence",
      answer: "Insufficient evidence in Memory to answer this question.",
      citations: [],
      cost: null,
      available: true,
      evidence,
      gap_analysis: gapAnalysis,
      what_i_dont_know: whatIDontKnow,
      federation_hits: federationHits,
    };
  }

  try {
    const { answer, cost } = await store.ask(askPrompt(question, evidence, gapAnalysis));
    return {
      question,
      status: "answered",
      answer,
      citations,
      cost,
      available: true,
      evidence,
      gap_analysis: gapAnalysis,
      what_i_dont_know: whatIDontKnow,
      federation_hits: federationHits,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      question,
      status: "provider-unavailable",
      answer: evidenceOnlyAnswer(evidence, gapAnalysis, error),
      citations,
      cost: null,
      available: false,
      evidence,
      gap_analysis: gapAnalysis,
      what_i_dont_know: whatIDontKnow,
      federation_hits: federationHits,
      error,
    };
  }
}

async function composeWhatIDontKnow(
  store: MemoryStore,
  question: string,
  gapAnalysis: AskGapAnalysis,
  now?: number,
): Promise<string[]> {
  const out: string[] = [...gapAnalysis.gaps];
  try {
    const { buildReasoningReplay } = await import("../reasoning/reasoning-replay.js");
    const replay = await buildReasoningReplay(store, question, { limit: 5, now });
    for (const gap of replay.gaps) out.push(gap);
  } catch {
    /* degrade silently — ask stays zero-token by default */
  }
  try {
    const { buildLearningDebtReport } = await import("../learning-debt.js");
    const report = await buildLearningDebtReport(
      store as unknown as import("../learning-debt.js").LearningDebtStore,
      { now },
    );
    for (const debt of report.categories.repeatedFailurePatterns) {
      if (debt.hasDurableLesson) continue;
      out.push(
        `repeated-failure: ${debt.pattern} (${debt.attemptCount} attempts) — no durable lesson recorded`,
      );
    }
  } catch {
    /* degrade silently */
  }
  return [...new Set(out)];
}

async function composeFederationHits(
  question: string,
  rootDir: string | undefined,
  now?: number,
): Promise<AskFederationHit[]> {
  if (!rootDir) return [];
  try {
    const { buildFederationReport } = await import("../federation.js");
    const report = await buildFederationReport(rootDir, question, { now });
    return report.results.map((hit) => ({
      origin_repo: hit.origin_repo,
      id: hit.id,
      score: hit.score,
      confidence_local: hit.confidence_local,
      confidence_remote: hit.confidence_remote,
      path: hit.path,
      excerpt: hit.excerpt,
    }));
  } catch {
    return [];
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

function buildAskGapAnalysis(evidence: AskEvidenceSummary): AskGapAnalysis {
  const gaps: string[] = [];
  const nextActions: string[] = [];
  const unresolvedContradictions = evidence.contradictory.filter((item) => !item.resolved);
  const totalEvidence = evidence.active.length + evidence.superseded.length;

  if (totalEvidence === 0) {
    return {
      status: "unsupported",
      summary: "Memory has no recalled evidence for this question.",
      gaps: ["No active or superseded Memory evidence matched the question."],
      next_actions: [
        "Store a grounded project fact or bootstrap repository docs before asking again.",
      ],
    };
  }

  if (unresolvedContradictions.length > 0) {
    gaps.push(`${unresolvedContradictions.length} unresolved contradiction(s) affect the evidence.`);
    nextActions.push("Resolve or supersede the contradictory Memory nodes before relying on the answer.");
  }

  if (evidence.active.length === 0 && evidence.superseded.length > 0) {
    gaps.push("Only superseded evidence matched the question.");
    nextActions.push("Ask against the active replacement evidence or add a current Memory node.");
  }

  if (evidence.byConfidence.EXTRACTED.length === 0) {
    gaps.push("No EXTRACTED evidence supports the answer.");
    nextActions.push("Ground this answer in source-backed extracted evidence when possible.");
  }

  if (evidence.active.length === 1) {
    gaps.push("Only one active citation supports the answer.");
    nextActions.push("Add independent supporting evidence if this answer will guide a risky change.");
  }

  if (gaps.length === 0) {
    return {
      status: "grounded",
      summary: "Memory has active, non-contradictory extracted evidence for this question.",
      gaps: [],
      next_actions: [],
    };
  }

  return {
    status: unresolvedContradictions.length > 0 ? "conflicted" : "partial",
    summary:
      unresolvedContradictions.length > 0
        ? "Memory found relevant evidence, but unresolved contradictions need attention."
        : "Memory found relevant evidence, but the support is incomplete.",
    gaps,
    next_actions: [...new Set(nextActions)],
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
    confidence_score: node.confidence,
    confidence_breakdown: node.confidence_breakdown,
  };
}

function askPrompt(
  question: string,
  evidence: AskEvidenceSummary,
  gapAnalysis: AskGapAnalysis,
): string {
  return [
    "Answer the question using only the Memory evidence below.",
    "Cite every substantive claim with the evidence marker, for example [1].",
    "If the evidence does not support an answer, reply with: Insufficient evidence.",
    "Call out contradictions and superseded evidence when relevant.",
    "End with a short gap note when the gap analysis is not grounded.",
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
    "",
    "Gap analysis:",
    ...renderAskGapAnalysis(gapAnalysis),
  ].join("\n");
}

function renderAskEvidence(items: AskEvidence[]): string[] {
  if (items.length === 0) return ["(none)"];
  return items.map((item) => {
    const source = item.source ? ` source=${item.source}` : "";
    const score =
      item.confidence_score != null ? ` confidence=${item.confidence_score.toFixed(3)}` : "";
    return `${item.citation} ${item.title} (${item.confidence}; rid=${item.rid}; ${item.status}${source}${score}) ${item.excerpt}`;
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

function renderAskGapAnalysis(gapAnalysis: AskGapAnalysis): string[] {
  return [
    `status=${gapAnalysis.status}`,
    `summary=${gapAnalysis.summary}`,
    `gaps=${gapAnalysis.gaps.length > 0 ? gapAnalysis.gaps.join(" | ") : "(none)"}`,
    `next_actions=${
      gapAnalysis.next_actions.length > 0 ? gapAnalysis.next_actions.join(" | ") : "(none)"
    }`,
  ];
}

function evidenceOnlyAnswer(
  evidence: AskEvidenceSummary,
  gapAnalysis: AskGapAnalysis,
  error: string,
): string {
  return [
    `Evidence-only fallback: LLM provider unavailable (${error}).`,
    "Active evidence:",
    ...renderAskEvidence(evidence.active),
    "Superseded evidence:",
    ...renderAskEvidence(evidence.superseded),
    "Contradictions:",
    ...renderAskContradictions(evidence.contradictory),
    "Confidence buckets:",
    `EXTRACTED: ${evidence.byConfidence.EXTRACTED.map((item) => item.citation).join(", ") || "(none)"}`,
    `INFERRED: ${evidence.byConfidence.INFERRED.map((item) => item.citation).join(", ") || "(none)"}`,
    `AMBIGUOUS: ${evidence.byConfidence.AMBIGUOUS.map((item) => item.citation).join(", ") || "(none)"}`,
    "Gap analysis:",
    ...renderAskGapAnalysis(gapAnalysis),
  ].join("\n");
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

function renderContext(
  query: string,
  nodes: RecalledNode[],
  diagnostics: RecallDiagnostics = emptyDiagnostics(),
): string {
  const vectorLine = renderVectorDiagnostic(diagnostics.vector);
  if (nodes.length === 0) {
    return `# Memory recall: ${query}\n\n_${vectorLine}_\n\n_(no relevant memory)_\n`;
  }
  const lines = [`# Memory recall: ${query}`, ""];
  lines.push(`_${vectorLine}_`, "");
  for (const n of nodes.slice(0, 12)) {
    const p = n.properties;
    const source = p.source ? ` — ${p.source}` : "";
    lines.push(`- **${p.title ?? n.label}** _(${n.node_type})_${source}`);
    const detail = p.summary ?? p.content;
    if (detail) lines.push(`  ${detail.slice(0, 200)}`);
    // attempt nodes carry their Envelope hook executions as a `hooks` array
    // (issue #216). Surface a one-line summary so recall consumers see which
    // user hooks fired without re-reading the raw Envelope.
    const hooksLine = renderAttemptHooks(p.hooks);
    if (hooksLine) lines.push(`  ${hooksLine}`);
    const lineageLine = renderSupersessionLine(p);
    if (lineageLine) lines.push(`  ${lineageLine}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderSupersessionLine(p: RecalledNode["properties"]): string | null {
  const supersededBy = numericProp(p.superseded_by);
  if (supersededBy == null) return null;
  const parts = [`superseded_by=memory_nodes:${supersededBy}`];
  const validFrom = numericProp(p.valid_from);
  const validUntil = numericProp(p.valid_until);
  if (validFrom != null) parts.push(`valid_from=${validFrom}`);
  if (validUntil != null) parts.push(`valid_until=${validUntil}`);
  return `_lineage: ${parts.join(" ")}_`;
}

function numericProp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function renderAttemptHooks(hooks: unknown): string | null {
  if (!Array.isArray(hooks) || hooks.length === 0) return null;
  const parts: string[] = [];
  for (const raw of hooks) {
    if (raw == null || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const lifecycle = typeof entry.lifecycle === "string" ? entry.lifecycle : "";
    if (!lifecycle) continue;
    const exit = entry.exit_code;
    const exitStr = typeof exit === "number" || typeof exit === "string" ? String(exit) : "?";
    parts.push(`${lifecycle}=${exitStr}`);
  }
  if (parts.length === 0) return null;
  return `_hooks: ${parts.join(", ")}_`;
}

function renderVectorDiagnostic(d: VectorRecallDiagnostics): string {
  if (d.status === "contributed") {
    return `vector retrieval contributed ${d.contributed} candidate(s)`;
  }
  if (d.status === "available") return "vector retrieval available; 0 candidate(s) contributed";
  const reason = d.reason ? `: ${d.reason}` : "";
  return `vector retrieval unavailable${reason}`;
}
