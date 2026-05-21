import { recall } from "./engine.js";
import type { MemoryStore } from "./graph-store.js";

export interface GraphRecallHit {
  /** Engine-assigned node rid, as a string for uniform CLI printing. */
  id: string;
  rid: number;
  label: string;
  node_type: string;
  score: number;
  excerpt: string;
}

/**
 * CLI-facing recall: a thin wrapper over the hybrid recall engine that flattens
 * its ranked nodes into the printable hit shape the `memory recall` command and
 * the `/memory:recall` skill consume. See `engine.ts` for the ranking and
 * graph-expansion logic.
 */
export async function graphRecall(
  store: MemoryStore,
  query: string,
  limit = 10,
): Promise<GraphRecallHit[]> {
  const { nodes } = await recall(store, query, { k: limit, depth: 1 });
  return nodes.slice(0, limit).map((n) => ({
    id: String(n.rid),
    rid: n.rid,
    label: n.label,
    node_type: n.node_type,
    score: n.score,
    excerpt: n.excerpt,
  }));
}
