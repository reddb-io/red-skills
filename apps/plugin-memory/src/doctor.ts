import type { MemoryStore, StoredNode } from "./graph-store.js";
import type { NodeType } from "./schema.js";

/** Pinned threshold — at or above this `importance`, decay never marks a node
 *  stale (PRD #49: 0.8+ is pinned). The schema's `PINNED_IMPORTANCE` (0.9) is
 *  the value `store` *sets* when pinning; this is the lower bound that counts. */
export const PINNED_IMPORTANCE_THRESHOLD = 0.8;

/**
 * memory:doctor — the maintenance + inspection surface over the graph.
 *
 * `diagnose` flags stale nodes by the PRD #49 rule — last accessed more than
 * `staleDays` ago AND never recalled (`access_count == 0`) — reading the access
 * overlay (`store.accessRecord`) the recall engine maintains. Pinned nodes
 * (`importance >= 0.8`) are always kept: pinning is the explicit "this matters"
 * signal, so it overrides the decay clock.
 *
 * `prune` deletes a set of stale nodes. It is pure mechanism — it never decides
 * what to delete. The CLI / MCP caller is responsible for showing the candidate
 * list and getting explicit confirmation first; nothing here auto-deletes.
 */

const MS_PER_DAY = 86_400_000;

/** A node flagged stale by `diagnose`, with the figures behind the decision. */
export interface StaleNode {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
  /** Last access (or write time, if never recalled), epoch ms. */
  accessedAt: number;
  /** Whole days since `accessedAt`. */
  ageDays: number;
  accessCount: number;
  importance: number;
}

export interface DoctorReport {
  totalNodes: number;
  /** The staleness threshold used, in days. */
  staleDays: number;
  stale: StaleNode[];
}

export interface DoctorOptions {
  /** A node is stale once unaccessed for this many days (default 90). */
  staleDays?: number;
  /** Clock injection point for tests; defaults to `Date.now()`. */
  now?: number;
}

/** Effective last-access time: the access overlay wins, else the node's
 *  write-time `accessed_at`/`created_at`. */
function lastAccess(node: StoredNode, overlayAt: number | null): number {
  if (overlayAt != null && overlayAt > 0) return overlayAt;
  const p = node.properties;
  return Number(p.accessed_at ?? p.created_at ?? 0);
}

/**
 * Flag stale nodes: unaccessed for `staleDays`+ AND never recalled. Pinned
 * nodes (importance ≥ 0.8) and `ephemeral` nodes (which expire on their own TTL,
 * issue #68) are exempt. Read-only — no deletion.
 */
export async function diagnose(
  store: MemoryStore,
  opts: DoctorOptions = {},
): Promise<DoctorReport> {
  const staleDays = opts.staleDays ?? 90;
  const now = opts.now ?? Date.now();
  const cutoff = staleDays * MS_PER_DAY;

  const nodes = await store.listNodes();
  // One read of the aggregate access overlay, not one per node (issue #72).
  const overlays = await store.accessRecords();
  const stale: StaleNode[] = [];

  for (const node of nodes) {
    // Ephemeral nodes expire on their own TTL horizon (issue #68); doctor only
    // flags stale *durable*/`reasoning` knowledge, never the transient tier.
    if (node.properties.tier === "ephemeral") continue;

    const importance = Number(node.properties.importance ?? 0);
    if (importance >= PINNED_IMPORTANCE_THRESHOLD) continue;

    const overlay = overlays.get(node.rid) ?? null;
    const accessCount = overlay?.count ?? Number(node.properties.access_count ?? 0);
    if (accessCount > 0) continue;

    const accessedAt = lastAccess(node, overlay?.accessed_at ?? null);
    const age = now - accessedAt;
    if (age < cutoff) continue;

    stale.push({
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      title: node.properties.title ?? node.label,
      accessedAt,
      ageDays: Math.floor(age / MS_PER_DAY),
      accessCount,
      importance,
    });
  }

  stale.sort((a, b) => b.ageDays - a.ageDays || a.rid - b.rid);
  return { totalNodes: nodes.length, staleDays, stale };
}

/**
 * Delete the given stale nodes. Resolves each rid to its full node (delete needs
 * label + node_type) and removes it. Returns how many were actually pruned.
 * The caller must have confirmed — this performs the deletion unconditionally.
 */
export async function prune(store: MemoryStore, stale: StaleNode[]): Promise<{ pruned: number }> {
  let pruned = 0;
  for (const candidate of stale) {
    const node = await store.getNode(candidate.rid);
    if (!node) continue;
    await store.deleteNode(node);
    pruned += 1;
  }
  return { pruned };
}
