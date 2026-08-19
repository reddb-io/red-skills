/**
 * L2 working-memory eviction (issue #182, PRD #174).
 *
 * Reaps L2 nodes (`properties.layer === "L2"`) when either of two policies
 * fires:
 *
 * 1. **TTL** — any L2 node whose `created_at` is older than the configured
 *    `ttlMs` is evicted. Catches abandoned sessions.
 * 2. **Byte budget** — per session, if the total byte footprint of L2 *event*
 *    nodes exceeds `byteBudget`, evict the oldest events (by `sequence`) until
 *    the session is back under budget. The raw transcript node survives this
 *    pass (it is the safety net for late re-extraction).
 *
 * L1 is naturally per-turn ephemeral and out of scope. L3 nodes are never
 * touched by this sweep — pruning durable knowledge stays manual via
 * `memory doctor`.
 *
 * Each evicted node emits one best-effort `engine.op evict` event to
 * `mem.events` (slice #181). Failure to record telemetry never blocks the
 * eviction.
 */
import { resolveL2Policy, type ResolvedL2Policy } from "./config.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { appendEngineOpEvent } from "./memory-events.js";

export interface EvictL2Options {
  /** Override `ttlMs` from policy. Falls back to resolved config default. */
  ttlMs?: number;
  /** Override `byteBudget` from policy. Falls back to resolved config default. */
  byteBudget?: number;
  /** Wall-clock for the TTL check; injectable for tests. */
  now?: number;
}

export type EvictReason = "ttl" | "byte-budget";

export interface EvictedRecord {
  rid: number;
  session_id: string;
  label: string;
  reason: EvictReason;
  bytes: number;
  age_ms: number;
}

export interface SessionReport {
  session_id: string;
  evicted: number;
  bytes_before: number;
  bytes_after: number;
  byte_budget_triggered: boolean;
}

export interface EvictReport {
  policy: ResolvedL2Policy;
  scanned_nodes: number;
  evicted: EvictedRecord[];
  by_session: SessionReport[];
}

const TRANSCRIPT_KIND = "transcript";
const EVENT_KIND = "event";

/** Run one L2 eviction sweep. Returns a structured report. */
export async function evictL2(
  store: MemoryStore,
  options: EvictL2Options = {},
): Promise<EvictReport> {
  const defaults = resolveL2Policy(null);
  const policy: ResolvedL2Policy = {
    ttlMs: options.ttlMs ?? defaults.ttlMs,
    byteBudget: options.byteBudget ?? defaults.byteBudget,
  };
  const now = options.now ?? Date.now();
  const allNodes = await store.listNodes();
  const l2Nodes = allNodes.filter((n) => n.properties.layer === "L2");

  const evicted: EvictedRecord[] = [];
  const toDelete: StoredNode[] = [];

  // --- Pass 1: TTL ---------------------------------------------------------
  const survivors: StoredNode[] = [];
  for (const n of l2Nodes) {
    const createdAt = Number(n.properties.created_at ?? 0);
    const age = now - createdAt;
    if (createdAt > 0 && age > policy.ttlMs) {
      toDelete.push(n);
      evicted.push({
        rid: n.rid,
        session_id: String(n.properties.session_id ?? ""),
        label: n.label,
        reason: "ttl",
        bytes: nodeBytes(n),
        age_ms: age,
      });
    } else {
      survivors.push(n);
    }
  }

  // --- Pass 2: byte budget (per session, events only) ---------------------
  const bySession = new Map<string, StoredNode[]>();
  for (const n of survivors) {
    if (n.properties.working_kind !== EVENT_KIND) continue;
    const sid = String(n.properties.session_id ?? "");
    if (!sid) continue;
    const list = bySession.get(sid) ?? [];
    list.push(n);
    bySession.set(sid, list);
  }

  const sessionReports: SessionReport[] = [];
  for (const [sid, events] of bySession) {
    events.sort((a, b) => Number(a.properties.sequence ?? 0) - Number(b.properties.sequence ?? 0));
    const sizes = events.map(nodeBytes);
    const bytesBefore = sizes.reduce((a, b) => a + b, 0);
    let bytesNow = bytesBefore;
    let evictedHere = 0;
    let triggered = false;
    let i = 0;
    while (bytesNow > policy.byteBudget && i < events.length) {
      triggered = true;
      const victim = events[i];
      toDelete.push(victim);
      const createdAt = Number(victim.properties.created_at ?? 0);
      evicted.push({
        rid: victim.rid,
        session_id: sid,
        label: victim.label,
        reason: "byte-budget",
        bytes: sizes[i],
        age_ms: createdAt > 0 ? now - createdAt : 0,
      });
      bytesNow -= sizes[i];
      evictedHere++;
      i++;
    }
    sessionReports.push({
      session_id: sid,
      evicted: evictedHere,
      bytes_before: bytesBefore,
      bytes_after: bytesNow,
      byte_budget_triggered: triggered,
    });
  }

  // --- Mark evicted + emit events -----------------------------------------
  if (toDelete.length > 0) {
    await store.recordEvicted(toDelete.map((n) => n.rid));
    for (const rec of evicted) {
      await appendEngineOpEvent(store, {
        op: "evict",
        outcome: "succeeded",
        layer: "L2",
        session_id: rec.session_id || undefined,
        node_id: rec.rid,
      });
    }
  }

  return {
    policy,
    scanned_nodes: l2Nodes.length,
    evicted,
    by_session: sessionReports,
  };
}

/** Approximate UTF-8 byte size of an L2 node's payload-bearing properties. */
function nodeBytes(node: StoredNode): number {
  const p = node.properties;
  const value = typeof p.value === "string" ? p.value : "";
  const content = typeof p.content === "string" ? p.content : "";
  const title = typeof p.title === "string" ? p.title : "";
  return (
    Buffer.byteLength(value, "utf8") +
    Buffer.byteLength(content, "utf8") +
    Buffer.byteLength(title, "utf8") +
    Buffer.byteLength(node.label, "utf8")
  );
}
