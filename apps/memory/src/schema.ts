/**
 * memory graph schema.
 *
 * Stable wire types for graph nodes, edges, and document chunks stored in
 * RedDB. Ported from red-memory `packages/core/src/schema.ts` (commit 483034e),
 * the proven shape behind ADR 0007. Keep aligned with PRD #49's data model.
 */

import type { StructuralType } from "./extraction-schema.js";

export const COLLECTIONS = {
  nodes: "memory_nodes",
  edges: "memory_edges",
  docs: "memory_docs",
  vectors: "memory_vectors",
  events: "memory_events",
  kv: "memory_kv",
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

/**
 * Memory tier (PRD #66, issue #68). Resolves the contradiction between RedDB's
 * auto-expiring TTL and the project's "no automatic deletion" guarantee:
 *
 * - `ephemeral` — transient session memory. Carries a TTL horizon
 *   (`expires_at`) and stops surfacing once that horizon passes.
 * - `durable` — stored facts and decisions. No TTL; persists indefinitely.
 *   `memory:doctor` may *flag* a durable node as stale but never auto-deletes it.
 * - `reasoning` — trace / why-note nodes. Like `durable`, no TTL.
 */
export type Tier = "ephemeral" | "durable" | "reasoning";

/**
 * Provenance authority tier for recall ranking (issue #1193).
 *
 * - `oracle` — execution-observed evidence such as command/test output or
 *   deterministic extractor facts marked EXTRACTED.
 * - `proxy` — AI-inferred, co-occurrence, manually migrated, or otherwise
 *   indirect evidence. Legacy graph rows without this field are treated as
 *   proxy by read paths.
 */
export type ProvenanceTier = "oracle" | "proxy";

/**
 * Memory layer (PRD #174, issue #175). The *physical* storage layer a Memory
 * node currently lives in. Orthogonal to {@link Tier}: tier names the retention
 * class, layer names the physical location and may change on promotion or
 * eviction.
 *
 * - `L1` — in-process hot cache, per-agent turn. Not yet populated by this
 *   slice; reserved for hot-path reads/writes inside one agent invocation.
 * - `L2` — RedDB session-scoped cache with TTL + size eviction. Not yet
 *   populated by this slice; reserved for session-bound ephemeral memory.
 * - `L3` — RedDB graph, durable. The only layer that physically stores nodes
 *   today; every existing recall/store call routes here.
 */
export type MemoryLayer = "L1" | "L2" | "L3";

/**
 * Applicability boundary for a memory fact (issue #116). Broader scopes are
 * safe to recall in more places; narrower scopes require matching context or
 * an explicit request before they surface.
 */
export type MemoryScope =
  | "user"
  | "project"
  | "repo"
  | "branch"
  | "worktree"
  | "session"
  | "agent-run";

export const NODE_TYPES = [
  "file",
  "import",
  "symbol",
  "concept",
  "decision",
  "problem",
  "solution",
  "fix",
  "workflow",
  "person",
  "why_note",
  "session",
  "task",
  "goal",
  "answer",
  // Engineering semantic graph (PRD #95): AFK execution history.
  "worker",
  "issue",
  "prd",
  "validation",
  // AFK lifecycle (PRD #174, issue #187): archived raw L2 transcript blob
  // copied into L3 as a durable artifact so re-extraction with a better
  // prompt stays possible after the worktree is gone.
  "transcript",
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_LABELS = [
  // Causal
  "CAUSES",
  "PREVENTS",
  "BLOCKS",
  "ENABLES",
  // Solution
  "SOLVES",
  "FIXES",
  "MITIGATES",
  "SUPERSEDED_BY",
  "SAME_AS",
  "MERGED_INTO",
  "DEPRECATED_BY",
  // Context
  "MENTIONS",
  "REFERENCES",
  "DESCRIBES",
  "CONTAINS",
  "DEFINED_IN",
  // Code
  "CALLS",
  "IMPORTS",
  "IMPLEMENTS",
  "EXTENDS",
  "USES_TYPE",
  // Learning
  "LEARNED_FROM",
  "CONTRADICTS",
  "CONFIRMS",
  "EXAMPLE_OF",
  // Workflow
  "PRECEDES",
  "TRIGGERS",
  "RUNS_AFTER",
  // Quality
  "TESTED_BY",
  "REVIEWED_BY",
  "OWNED_BY",
  // Audit — a reasoning trace (why_note) → the entities it affected (issue #72).
  "TOUCHED",
] as const;

export type EdgeLabel = (typeof EDGE_LABELS)[number];

export const HIDDEN_BY_EDGE_LABELS = [
  "SUPERSEDED_BY",
  "SAME_AS",
  "MERGED_INTO",
] as const satisfies readonly EdgeLabel[];

export type HiddenByEdgeLabel = (typeof HIDDEN_BY_EDGE_LABELS)[number];

export interface MemoryNodeProps {
  title: string;
  summary?: string;
  content?: string;
  tags?: string[];
  importance?: number;
  confidence?: Confidence;
  source?: string;
  provenance?: MemoryProvenance;
  /**
   * Authority tier for ranking. New writes always stamp this; legacy rows that
   * predate #1193 omit it and are read as `proxy`.
   */
  provenance_tier?: ProvenanceTier;
  language?: string;
  project?: string;
  /** Scope classification for safe recall filtering; defaults to `project`. */
  scope?: MemoryScope;
  /** Identifier for the scope when one is available (project name, branch, etc.). */
  scope_id?: string;
  /** Memory tier; defaults on write per `defaultTier(node_type)`. */
  tier?: Tier;
  /**
   * Memory storage layer; defaults on write per `defaultLayer(node_type)`.
   * Indexed for filtering by recall and the layer router. Today's nodes all
   * default to `L3` (durable graph); L1/L2 are reserved for future slices.
   */
  layer?: MemoryLayer;
  created_at?: number;
  updated_at?: number;
  accessed_at?: number;
  access_count?: number;
  /**
   * TTL horizon (epoch ms) for `ephemeral` nodes only. Once `now >= expires_at`
   * the node stops surfacing in any read path. Absent on `durable`/`reasoning`
   * nodes, which persist indefinitely.
   */
  expires_at?: number;
  supersedes_rid?: number;
  /**
   * Closed structural-type axis (ADR 0035). Set by the strict-write gate on the
   * provider/`INFERRED` path: the valid structural home a proposed kind resolved
   * to (in-vocabulary kinds map to themselves; everything else to the base type).
   * Indexed so recall can filter/rank by it alongside `tier`/`type`.
   */
  structural_type?: StructuralType;
  /**
   * Open engineering-code axis (ADR 0035): the fine-grained "why"/kind
   * classification (`decision`, `gotcha`, `root-cause`, …) carried losslessly
   * even when the proposed kind is out of the structural vocabulary. Indexed —
   * a real recall filter/rank dimension, not opaque metadata.
   */
  engineering_code?: string;
  /** dedupe hash (stable per source+content) */
  hash?: string;
  [extra: string]: unknown;
}

export interface MemoryProvenance {
  source_kind: "manual" | "hook" | "derived" | "system" | "external-map";
  writer?: string;
  command?: string;
  hook?: string;
  scope?: {
    level?: MemoryScope;
    id?: string;
  };
  confidence?: Confidence;
  evidence?: string[];
  created_at?: number;
  updated_at?: number;
  [extra: string]: unknown;
}

export interface MemoryEdgeProps {
  confidence?: Confidence;
  source?: string;
  weight?: number;
  topological_weight?: number;
  reason?: string;
  provenance?: MemoryProvenance;
  /**
   * Authority tier for ranking/governance. New writes always stamp this;
   * pre-existing edges without it are treated as `proxy`.
   */
  provenance_tier?: ProvenanceTier;
  extraction_backend?: string;
  source_location?: string;
  created_at?: number;
  [extra: string]: unknown;
}

export interface MemoryNode {
  rid?: number;
  label: string;
  node_type: NodeType;
  properties: MemoryNodeProps;
}

export interface MemoryEdge {
  rid?: number;
  label: EdgeLabel;
  from_rid: number;
  to_rid: number;
  weight?: number;
  properties?: MemoryEdgeProps;
}

export interface MemoryDoc {
  rid?: number;
  path: string;
  title?: string;
  body: string;
  frontmatter?: Record<string, unknown>;
  hash: string;
  updated_at: number;
}

export interface RecallResult {
  query: string;
  nodes: Array<MemoryNode & { score: number; rid: number }>;
  edges: MemoryEdge[];
  context_md: string;
}

export const DEFAULT_IMPORTANCE = 0.5;
export const PINNED_IMPORTANCE = 0.9;

/** Default TTL horizon for `ephemeral` nodes: 24 hours of session lifetime. */
export const DEFAULT_EPHEMERAL_TTL_MS = 86_400_000;

/**
 * Default tier for a node written without an explicit `tier` (issue #68):
 * `session` nodes are transient → `ephemeral`; `why_note` trace nodes →
 * `reasoning`; everything else (facts, decisions, code, …) → `durable`.
 */
/**
 * Default storage layer for a node written without an explicit `layer`
 * (issue #175). This slice only populates `L3`; subsequent slices will
 * introduce promotion/eviction paths into `L1`/`L2`. Returning `L3` for every
 * node keeps today's behaviour observably identical.
 */
export function defaultLayer(_node_type: NodeType): MemoryLayer {
  return "L3";
}

export function defaultTier(node_type: NodeType): Tier {
  switch (node_type) {
    case "session":
      return "ephemeral";
    case "why_note":
    case "worker":
      return "reasoning";
    default:
      return "durable";
  }
}
