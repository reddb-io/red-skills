/**
 * L2 working memory (PRD #174, issue #178). Session-scoped layer that captures
 * two parallel streams per agent session:
 *
 * - **Typed event stream** — `user_input`, `agent_action`, `tool_call`,
 *   `tool_result`, `decision_candidate`, `gotcha_candidate`, etc. Source of
 *   truth for downstream promotion (slice #5 reads it).
 * - **Raw transcript blob** — the verbatim transcript kept as one L2 node per
 *   session; safety net for late re-extraction.
 *
 * Both streams persist as graph nodes with `properties.layer === "L2"` and
 * `properties.session_id === <current>`, filterable through the same
 * `memory_nodes` collection the rest of the graph already uses (see
 * `layer-router.ts` header). No new namespace machinery.
 */
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { runPromote } from "./promote.js";
import { current as sessionCurrent } from "./session-manager.js";

export const NO_SESSION_MSG =
  "no session — run `memory session show` or start one";

/**
 * L2 overflow threshold (issue #183). Once a session's L2 event count crosses
 * this many entries, the next append triggers a PromotionEngine pass before
 * eviction can trim the buffer. Configurable via the env var; default keeps
 * the buffer roomy enough for normal turns but firm enough that a runaway
 * session can't accumulate forever.
 */
export const DEFAULT_L2_OVERFLOW_THRESHOLD = 200;

function l2OverflowThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RED_MEMORY_L2_OVERFLOW_THRESHOLD;
  if (!raw) return DEFAULT_L2_OVERFLOW_THRESHOLD;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_L2_OVERFLOW_THRESHOLD;
}

export interface WorkingEvent {
  rid: number;
  session_id: string;
  type: string;
  value: string;
  sequence: number;
  created_at: number;
}

export interface AppendEventInput {
  type: string;
  value: string;
}

/** Append a typed event to the current session's L2 stream. */
export async function appendEvent(
  store: MemoryStore,
  rootDir: string,
  input: AppendEventInput,
): Promise<WorkingEvent> {
  const session_id = await requireSession(rootDir);
  const sequence = await nextSequence(store, session_id);
  const created_at = Date.now();
  const label = `working:event:${session_id}:${sequence}`;
  const rid = await store.upsertNode({
    label,
    node_type: "session",
    properties: {
      title: `${input.type} event @${session_id}`,
      tier: "ephemeral",
      layer: "L2",
      scope: "session",
      scope_id: session_id,
      session_id,
      working_kind: "event",
      event_type: input.type,
      value: input.value,
      sequence,
      created_at,
    },
  });
  // Overflow backstop (issue #183): once L2 crosses the configured threshold,
  // drain promotable candidates into L3 before eviction can reap them. Covers
  // runners (Codex pre-2026-05) that don't have a PreCompact hook to lean on.
  if (sequence >= l2OverflowThreshold()) {
    try {
      await runPromote(store, rootDir, { triggeredBy: "overflow", sessionId: session_id });
    } catch {
      // Overflow is a backstop — never let it fail the L2 write that triggered it.
    }
  }
  return { rid, session_id, type: input.type, value: input.value, sequence, created_at };
}

/** List events for the current session, ordered by write time. */
export async function listEvents(
  store: MemoryStore,
  rootDir: string,
  opts: { type?: string } = {},
): Promise<WorkingEvent[]> {
  const session_id = await requireSession(rootDir);
  const nodes = await store.listNodes();
  return nodes
    .filter((n) => isWorkingEventNode(n, session_id))
    .filter((n) => !opts.type || n.properties.event_type === opts.type)
    .map(toEvent)
    .sort((a, b) => a.sequence - b.sequence);
}

/** Write (or replace) the raw transcript blob for the current session. */
export async function setRawTranscript(
  store: MemoryStore,
  rootDir: string,
  value: string,
): Promise<{ rid: number; session_id: string; value: string }> {
  const session_id = await requireSession(rootDir);
  const nodes = await store.listNodes();
  for (const n of nodes) {
    if (isWorkingTranscriptNode(n, session_id)) {
      await store.deleteNode(n);
    }
  }
  const label = `working:transcript:${session_id}`;
  const rid = await store.upsertNode({
    label,
    node_type: "session",
    properties: {
      title: `raw transcript @${session_id}`,
      content: value,
      tier: "ephemeral",
      layer: "L2",
      scope: "session",
      scope_id: session_id,
      session_id,
      working_kind: "transcript",
      value,
      created_at: Date.now(),
    },
  });
  return { rid, session_id, value };
}

/** Read the raw transcript blob for the current session, or `null`. */
export async function getRawTranscript(
  store: MemoryStore,
  rootDir: string,
): Promise<{ session_id: string; value: string } | null> {
  const session_id = await requireSession(rootDir);
  const nodes = await store.listNodes();
  const found = nodes.find((n) => isWorkingTranscriptNode(n, session_id));
  if (!found) return null;
  return { session_id, value: String(found.properties.value ?? "") };
}

async function requireSession(rootDir: string): Promise<string> {
  const id = await sessionCurrent(rootDir);
  if (!id) throw new Error(NO_SESSION_MSG);
  return id;
}

async function nextSequence(
  store: MemoryStore,
  session_id: string,
): Promise<number> {
  const nodes = await store.listNodes();
  let max = 0;
  for (const n of nodes) {
    if (!isWorkingEventNode(n, session_id)) continue;
    const seq = Number(n.properties.sequence ?? 0);
    if (seq > max) max = seq;
  }
  return max + 1;
}

function isWorkingEventNode(node: StoredNode, session_id: string): boolean {
  const p = node.properties;
  return (
    p.layer === "L2" &&
    p.session_id === session_id &&
    p.working_kind === "event"
  );
}

function isWorkingTranscriptNode(node: StoredNode, session_id: string): boolean {
  const p = node.properties;
  return (
    p.layer === "L2" &&
    p.session_id === session_id &&
    p.working_kind === "transcript"
  );
}

function toEvent(node: StoredNode): WorkingEvent {
  const p = node.properties;
  return {
    rid: node.rid,
    session_id: String(p.session_id),
    type: String(p.event_type ?? ""),
    value: String(p.value ?? ""),
    sequence: Number(p.sequence ?? 0),
    created_at: Number(p.created_at ?? 0),
  };
}
