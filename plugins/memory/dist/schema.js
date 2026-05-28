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
    events: "memory_events",
    kv: "memory_kv",
};
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
export function defaultLayer(_node_type) {
    return "L3";
}
export function defaultTier(node_type) {
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
