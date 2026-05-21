import type { MemoryStore, StoredNode } from "./graph-store.js";
import { tokenize } from "./recall.js";

export interface GraphRecallHit {
  /** Engine-assigned node rid, as a string for uniform CLI printing. */
  id: string;
  rid: number;
  label: string;
  node_type: string;
  score: number;
  excerpt: string;
}

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

/**
 * Recall over the graph: scan nodes, score by query-term overlap, drop nodes
 * that have been superseded (return the head of a `SUPERSEDED_BY` chain), and
 * expand the top seeds by one graph hop so related nodes surface even when they
 * don't match the query text directly.
 *
 * FTS/`SEARCH TEXT` over graph node properties is unavailable in this engine
 * build, so the seed pass is a client-side term scan — the same scoring shape
 * as markdown recall, kept reliable for the round-trip.
 */
export async function graphRecall(
  store: MemoryStore,
  query: string,
  limit = 10,
): Promise<GraphRecallHit[]> {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const nodes = await store.listNodes();
  const byRid = new Map<number, StoredNode>();
  for (const n of nodes) byRid.set(n.rid, n);

  const scored = new Map<number, number>();
  for (const node of nodes) {
    let score = 0;
    for (const token of tokenize(nodeText(node))) {
      if (terms.includes(token)) score += 1;
    }
    if (score > 0) scored.set(node.rid, score);
  }

  // Expand the top seeds one hop: a neighbor inherits half the seed's score so
  // direct text matches always outrank graph-only neighbors.
  const seeds = [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  for (const [rid, score] of seeds) {
    const seed = byRid.get(rid);
    if (!seed) continue;
    for (const neighbor of await store.neighborhood(seed.label, 1, "both")) {
      if (!byRid.has(neighbor.rid)) byRid.set(neighbor.rid, neighbor);
      if (!scored.has(neighbor.rid)) scored.set(neighbor.rid, score * 0.5);
    }
  }

  const hits: GraphRecallHit[] = [];
  for (const [rid, score] of scored) {
    // Head-of-chain default: a superseded node is hidden behind its successor.
    if ((await store.supersededBy(rid)) != null) continue;
    const node = byRid.get(rid);
    if (!node) continue;
    hits.push({
      id: String(rid),
      rid,
      label: node.label,
      node_type: node.node_type,
      score,
      excerpt: excerptOf(node),
    });
  }

  hits.sort((a, b) => b.score - a.score || a.rid - b.rid);
  return hits.slice(0, limit);
}
