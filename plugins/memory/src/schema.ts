/**
 * memory graph schema.
 *
 * Stable wire types for graph nodes, edges, and document chunks stored in
 * RedDB. Ported from red-memory `packages/core/src/schema.ts` (commit 483034e),
 * the proven shape behind ADR 0007. Keep aligned with PRD #49's data model.
 */

export const COLLECTIONS = {
  nodes: "memory_nodes",
  edges: "memory_edges",
  docs: "memory_docs",
  vectors: "memory_vectors",
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

export type NodeType =
  | "file"
  | "import"
  | "symbol"
  | "concept"
  | "decision"
  | "problem"
  | "solution"
  | "fix"
  | "workflow"
  | "person"
  | "why_note"
  | "session"
  | "task"
  | "goal"
  // Engineering semantic graph (PRD #95): AFK execution history.
  | "attempt"
  | "issue"
  | "prd";

export type EdgeLabel =
  // Causal
  | "CAUSES"
  | "PREVENTS"
  | "BLOCKS"
  | "ENABLES"
  // Solution
  | "SOLVES"
  | "FIXES"
  | "MITIGATES"
  | "SUPERSEDED_BY"
  | "DEPRECATED_BY"
  // Context
  | "MENTIONS"
  | "REFERENCES"
  | "DESCRIBES"
  | "CONTAINS"
  | "DEFINED_IN"
  // Code
  | "CALLS"
  | "IMPORTS"
  | "IMPLEMENTS"
  | "EXTENDS"
  | "USES_TYPE"
  // Learning
  | "LEARNED_FROM"
  | "CONTRADICTS"
  | "CONFIRMS"
  | "EXAMPLE_OF"
  // Workflow
  | "PRECEDES"
  | "TRIGGERS"
  | "RUNS_AFTER"
  // Quality
  | "TESTED_BY"
  | "REVIEWED_BY"
  | "OWNED_BY"
  // Audit — a reasoning trace (why_note) → the entities it affected (issue #72).
  | "TOUCHED";

export interface MemoryNodeProps {
  title: string;
  summary?: string;
  content?: string;
  tags?: string[];
  importance?: number;
  confidence?: Confidence;
  source?: string;
  language?: string;
  project?: string;
  /** Memory tier; defaults on write per `defaultTier(node_type)`. */
  tier?: Tier;
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
  /** dedupe hash (stable per source+content) */
  hash?: string;
  [extra: string]: unknown;
}

export interface MemoryEdgeProps {
  confidence?: Confidence;
  source?: string;
  weight?: number;
  reason?: string;
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
export function defaultTier(node_type: NodeType): Tier {
  switch (node_type) {
    case "session":
      return "ephemeral";
    case "why_note":
    case "attempt":
      return "reasoning";
    default:
      return "durable";
  }
}
