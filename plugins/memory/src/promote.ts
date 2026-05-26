/**
 * Promote runtime (PRD #174, issue #183). Wires {@link runPromotionEngine}
 * against a real session + L3 store: pulls L2 typed events for the current
 * session, queries L3 candidates, runs the pure engine, then applies the
 * decisions — write promoted nodes to L3, bump reinforced overlay for hits.
 *
 * Each decision (promote or reinforce) emits a `promote` event to
 * `memory_events` via {@link appendEngineOpEvent} (slice #181), so the
 * dashboard, the doctor, and ops telemetry can see one event per
 * promoted/reinforced node.
 */
import type { MemoryStore, StoredNode } from "./graph-store.js";
import {
  appendEngineOpEvent,
  type EngineOpInput,
} from "./memory-events.js";
import {
  runPromotionEngine,
  type PromotionCandidate,
  type PromotionExistingNode,
  type PromotionOptions,
  type PromotionResult,
} from "./promotion-engine.js";
import type { MemoryNode, NodeType } from "./schema.js";
import { current as sessionCurrent } from "./session-manager.js";
import { slugify } from "./store.js";

const NO_SESSION_MSG = "no session — run `memory session show` or start one";

/** Map an L2 event type string to the L3 node_type the engine should target. */
function candidateTypeToNodeType(eventType: string): NodeType | null {
  const base = eventType.replace(/_candidate$/i, "").toLowerCase();
  switch (base) {
    case "decision":
      return "decision";
    case "fix":
      return "fix";
    case "validation":
      return "validation";
    case "why_note":
    case "reasoning":
      return "why_note";
    case "solution":
      return "solution";
    case "problem":
      return "problem";
    case "gotcha":
      // No `gotcha` node type in the schema; represent as a why_note that
      // explains a pitfall — the closest typed durable shape we have.
      return "why_note";
    default:
      return null;
  }
}

interface L2Candidate {
  rid: number;
  event_type: string;
  value: string;
  sequence: number;
}

function l2EventNodes(nodes: readonly StoredNode[], session_id: string): L2Candidate[] {
  const out: L2Candidate[] = [];
  for (const n of nodes) {
    const p = n.properties;
    if (p.layer !== "L2") continue;
    if (p.session_id !== session_id) continue;
    if (p.working_kind !== "event") continue;
    const event_type = String(p.event_type ?? "");
    if (!event_type) continue;
    out.push({
      rid: n.rid,
      event_type,
      value: String(p.value ?? ""),
      sequence: Number(p.sequence ?? 0),
    });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

function l3Existing(nodes: readonly StoredNode[]): PromotionExistingNode[] {
  const out: PromotionExistingNode[] = [];
  for (const n of nodes) {
    if (n.properties.layer === "L2") continue;
    out.push({
      rid: n.rid,
      type: n.node_type,
      title: String(n.properties.title ?? n.label),
      content: typeof n.properties.content === "string" ? n.properties.content : undefined,
      reinforced: Number(n.properties.reinforced ?? 0) || 0,
    });
  }
  return out;
}

/**
 * Map an L2 event into a candidate the engine can reason about. Returns null
 * for event types the engine should never see (raw tool calls, transcripts).
 */
function candidateFromEvent(event: L2Candidate): PromotionCandidate | null {
  const text = event.value.trim();
  if (!text) return null;
  const nodeType = candidateTypeToNodeType(event.event_type);
  // Pass non-promotable types through so the engine surfaces them in `skipped`
  // (visibility into what L2 carries vs what makes it into L3). Only the
  // type-gate-accepted ones get the L3 node_type assigned here.
  const candidateType = nodeType ?? event.event_type;
  const [firstLine, ...rest] = text.split(/\r?\n/);
  const title = (firstLine ?? text).slice(0, 200);
  const content = rest.length > 0 ? text : undefined;
  return {
    id: event.rid,
    type: candidateType,
    title,
    content,
    meta: { event_rid: event.rid, sequence: event.sequence },
  };
}

export interface PromoteReport {
  session_id: string;
  promoted: number;
  reinforced: number;
  skipped: number;
  promoted_rids: number[];
  reinforced_rids: number[];
  decisions: PromotionResult["decisions"];
}

export interface PromoteOptions {
  /** Promotion engine options pass-through. */
  engine?: PromotionOptions;
  /** Override the session id (otherwise resolved from `session-manager`). */
  sessionId?: string;
  /** Provenance tag injected onto newly promoted L3 nodes. */
  triggeredBy?: "explicit" | "hook" | "overflow";
}

/**
 * Run the promotion engine for `sessionId` (or the current session) against
 * the supplied store. Pure orchestration: read → engine → apply → emit.
 */
export async function runPromote(
  store: MemoryStore,
  rootDir: string,
  opts: PromoteOptions = {},
): Promise<PromoteReport> {
  const session_id = opts.sessionId ?? (await sessionCurrent(rootDir));
  if (!session_id) throw new Error(NO_SESSION_MSG);
  const triggeredBy = opts.triggeredBy ?? "explicit";

  const all = await store.listNodes();
  const l2 = l2EventNodes(all, session_id);
  const existing = l3Existing(all);
  // Layer in the live reinforced count from the KV overlay (graph collections
  // can't UPDATE, so the overlay is the source of truth).
  const overlay = await store.reinforcementRecords();
  for (const node of existing) {
    const fromOverlay = overlay.get(node.rid);
    if (fromOverlay != null) node.reinforced = fromOverlay;
  }

  const candidates: PromotionCandidate[] = [];
  for (const event of l2) {
    const c = candidateFromEvent(event);
    if (c) candidates.push(c);
  }

  const result = runPromotionEngine({
    candidates,
    existing,
    options: opts.engine,
  });

  const promoted_rids: number[] = [];
  for (const p of result.promote) {
    const node: MemoryNode = {
      label: slugify(p.candidate.title || String(p.candidate.id)),
      node_type: p.candidate.type as NodeType,
      properties: {
        title: p.candidate.title,
        ...(p.candidate.content ? { content: p.candidate.content } : {}),
        source: `promote:${triggeredBy}:session=${session_id}`,
        confidence: "EXTRACTED",
        layer: "L3",
        provenance: {
          source_kind: "derived",
          writer: "memory",
          command: `memory promote (${triggeredBy})`,
          evidence: [`session:${session_id}`, `l2_event_rid:${p.candidate.id}`],
        },
      },
    };
    const rid = await store.upsertNode(node);
    promoted_rids.push(rid);
    await emitPromoteEvent(store, {
      op: "promote",
      outcome: "created",
      layer: "L3",
      session_id,
      node_id: rid,
    });
  }

  const reinforced_rids: number[] = [];
  for (const r of result.reinforce) {
    const count = await store.recordReinforcement(r.target_rid);
    reinforced_rids.push(r.target_rid);
    await emitPromoteEvent(store, {
      op: "promote",
      outcome: "deduped",
      layer: "L3",
      session_id,
      node_id: r.target_rid,
      hit_count: count,
    });
  }

  return {
    session_id,
    promoted: result.promote.length,
    reinforced: result.reinforce.length,
    skipped: result.skipped.length,
    promoted_rids,
    reinforced_rids,
    decisions: result.decisions,
  };
}

async function emitPromoteEvent(
  store: MemoryStore,
  input: EngineOpInput,
): Promise<void> {
  await appendEngineOpEvent(store, input);
}
