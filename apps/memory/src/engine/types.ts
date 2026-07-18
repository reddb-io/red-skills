import type { ConfidenceBreakdown } from "../confidence-scoring.js";
import type {
  AskCost,
  GraphRow,
  MemoryStore,
  SearchRow,
  ShortestPathResult,
  StoredNode,
} from "../graph-store.js";
import type {
  Confidence,
  MemoryNodeProps,
  MemoryScope,
  NodeType,
  ProvenanceTier,
  Tier,
} from "../schema.js";

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
  /** Composed confidence in [0, 1] with per-signal breakdown (issue #167). */
  confidence?: number;
  confidence_breakdown?: ConfidenceBreakdown;
}

export interface RecallResult {
  query: string;
  nodes: RecalledNode[];
  /** Markdown block ready to inject into a system note. */
  context_md: string;
  diagnostics: RecallDiagnostics;
}

export interface RecallDiagnostics {
  vector: VectorRecallDiagnostics;
}

export interface VectorRecallDiagnostics {
  status: "unavailable" | "available" | "contributed";
  /** Raw vector rows returned by the store before governance filters. */
  candidates: number;
  /** Vector rows that added or strengthened recall candidates. */
  contributed: number;
  reason?: string;
}

export interface RecallOptions {
  /** Number of FTS seeds to expand from (default 8). */
  k?: number;
  /** Graph hops to expand each seed (default 1, 0 disables expansion). */
  depth?: number;
  /** Restrict results to these node types. */
  types?: string[];
  /**
   * Restrict results to these engineering codes — the open semantic axis
   * (ADR 0035). Codes are normalized before comparison, so `root-cause`,
   * `Root Cause`, and `root_cause` all match. This is the axis being a real
   * query dimension rather than opaque metadata.
   */
  codes?: string[];
  /** Resolve explicit code aliases for recall/filter grouping. */
  codeCanonicalize?: (code: string) => string;
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
  searchVector?(query: string, limit?: number): Promise<SearchRow[]>;
  neighborhood(
    label: string,
    depth?: number,
    direction?: "outgoing" | "incoming" | "both",
  ): Promise<GraphRow[]>;
  supersededByMany(rids: number[]): Promise<Map<number, number>>;
  recordAccess?(rids: number[], now?: number): Promise<void>;
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

export const TRUST_WEIGHT: Record<Confidence, number> = {
  EXTRACTED: 1.0,
  INFERRED: 0.85,
  AMBIGUOUS: 0.65,
};

export const PROVENANCE_TIER_WEIGHT: Record<ProvenanceTier, number> = {
  oracle: 1.15,
  proxy: 1.0,
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
  /** Provenance/confidence trust multiplier in (0, 1]. */
  trust?: number;
  /** Authority tier multiplier. Missing legacy rows are scored as proxy. */
  provenanceTier?: ProvenanceTier;
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
  const provenanceTier = i.provenanceTier ?? "proxy";
  return (
    i.relevance *
    i.importance *
    recency *
    centrality *
    TIER_WEIGHT[i.tier] *
    PROVENANCE_TIER_WEIGHT[provenanceTier] *
    (i.trust ?? 1)
  );
}

export interface AskResult {
  question: string;
  status: "answered" | "insufficient-evidence" | "provider-unavailable";
  /** Grounded answer, or a cited evidence-only fallback when ASK is unavailable. */
  answer: string | null;
  citations: AskCitation[];
  /** Per-call usage and billing metadata; null when ASK is unavailable. */
  cost: AskCost | null;
  /** False when the engine has no LLM key — recall stays zero-token regardless. */
  available: boolean;
  evidence: AskEvidenceSummary;
  gap_analysis: AskGapAnalysis;
  /**
   * Compositional gaps (issue #173): explicit "what I don't know" surface
   * from learning-debt repeated-failure patterns and reasoning-replay gaps.
   * Always present (possibly empty) for backwards-compatible additive shape.
   */
  what_i_dont_know: string[];
  /**
   * Federation hits (issue #173): when `.red/memory/federation.yaml` exists
   * and returned results for this question, each hit is summarized with its
   * origin repo and confidence signals. Empty when federation is not
   * configured or returned no results.
   */
  federation_hits: AskFederationHit[];
  error?: string;
}

export interface AskCitation {
  marker: number;
  urn: string;
  /** Per-citation composed confidence in [0, 1] (issue #167 / #173). Null when unavailable. */
  confidence: number | null;
}

export interface AskFederationHit {
  origin_repo: string;
  id: string | null;
  score: number;
  confidence_local: number;
  confidence_remote: number;
  path: string | null;
  excerpt: string | null;
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
  /** Composed confidence in [0, 1] (issue #167). */
  confidence_score?: number;
  confidence_breakdown?: ConfidenceBreakdown;
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

export interface AskGapAnalysis {
  status: "grounded" | "partial" | "unsupported" | "conflicted";
  summary: string;
  gaps: string[];
  next_actions: string[];
}
