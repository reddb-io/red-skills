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

export type NodeType =
  | "file"
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
  | "goal";

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
  | "OWNED_BY";

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
  created_at?: number;
  updated_at?: number;
  accessed_at?: number;
  access_count?: number;
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
