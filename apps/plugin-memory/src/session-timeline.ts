import type { MemoryStore } from "./graph-store.js";
import { readMemoryEvents, type MemoryEvent } from "./memory-events.js";

export interface SessionTimelineEntry {
  id: string;
  occurred_at: string;
  kind: MemoryEvent["kind"];
  session_id: string;
  actor: string;
  title: string;
  detail: string;
  outcome: "succeeded" | "failed" | "noop" | "unknown";
  source: string;
}

export interface SessionTimeline {
  schema_version: "memory.session_timeline.v1";
  read_only: true;
  generated_at: string;
  filter: {
    session_id: string | null;
    limit: number;
  };
  summary: {
    sessions: number;
    events: number;
    hook_events: number;
    skill_events: number;
    failures: number;
    noops: number;
  };
  sessions: Array<{
    session_id: string;
    events: number;
    first_event_at: string;
    last_event_at: string;
  }>;
  entries: SessionTimelineEntry[];
  recommended_next_actions: string[];
}

export async function buildSessionTimeline(
  store: MemoryStore,
  opts: { sessionId?: string; limit?: number; now?: number } = {},
): Promise<SessionTimeline> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const allEvents = await readMemoryEvents(store);
  const events = allEvents
    .filter((event) => !opts.sessionId || sessionIdOf(event) === opts.sessionId)
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const entries = events.slice(-limit).map(toEntry);
  const sessions = summarizeSessions(entries);
  return {
    schema_version: "memory.session_timeline.v1",
    read_only: true,
    generated_at: new Date(opts.now ?? Date.now()).toISOString(),
    filter: { session_id: opts.sessionId ?? null, limit },
    summary: {
      sessions: sessions.length,
      events: entries.length,
      hook_events: entries.filter((entry) => entry.kind === "hook.lifecycle").length,
      skill_events: entries.filter((entry) => entry.kind === "skill.telemetry").length,
      failures: entries.filter((entry) => entry.outcome === "failed").length,
      noops: entries.filter((entry) => entry.outcome === "noop").length,
    },
    sessions,
    entries,
    recommended_next_actions: timelineActions(entries, opts.sessionId),
  };
}

function toEntry(event: MemoryEvent): SessionTimelineEntry {
  const payload = event.payload;
  if (payload.event_type === "engine.op") {
    const detailParts = [
      payload.layer ? `layer:${payload.layer}` : null,
      payload.hit_count != null ? `${payload.hit_count} hit(s)` : null,
      payload.node_id ? `node:${payload.node_id}` : null,
      payload.query ? `query:${payload.query}` : null,
    ].filter((part): part is string => Boolean(part));
    return {
      id: event.id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      session_id: sessionIdOf(event),
      actor: actorOf(event),
      title: `engine.${payload.op}`,
      detail: detailParts.join("; ") || payload.outcome,
      outcome: engineOutcome(payload.outcome),
      source: sourceOf(event),
    };
  }
  if (payload.event_type === "hook.lifecycle") {
    const parts = [
      payload.result.stored != null ? `${payload.result.stored} stored` : null,
      payload.result.indexed != null ? `${payload.result.indexed} indexed` : null,
      payload.result.injected_chars != null ? `${payload.result.injected_chars} injected chars` : null,
      payload.changed_files.length > 0 ? `${payload.changed_files.length} changed file(s)` : null,
      payload.result.reason,
    ].filter((part): part is string => Boolean(part));
    return {
      id: event.id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      session_id: sessionIdOf(event),
      actor: actorOf(event),
      title: `${payload.hook_event} hook`,
      detail: parts.join("; ") || "hook completed",
      outcome: payload.result.noop ? "noop" : "succeeded",
      source: sourceOf(event),
    };
  }

  if (payload.event_type === "memory.drift.caught") {
    return {
      id: event.id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      session_id: sessionIdOf(event),
      actor: actorOf(event),
      title: "memory drift caught",
      detail: `${payload.changed_paths.length} unmarked watched path(s): ${payload.changed_paths.join(", ")}`,
      outcome: "failed",
      source: sourceOf(event),
    };
  }

  if (payload.event_type === "memory.context-pack.generated") {
    return {
      id: event.id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      session_id: sessionIdOf(event),
      actor: actorOf(event),
      title: "context pack generated",
      detail: `${payload.entry_count} citation(s); ${payload.used_chars} chars; surface:${payload.surface}`,
      outcome: payload.status === "ok" ? "succeeded" : "noop",
      source: sourceOf(event),
    };
  }

  if (payload.event_type === "memory.injection.delivered") {
    return {
      id: event.id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      session_id: sessionIdOf(event),
      actor: actorOf(event),
      title: "memory injection delivered",
      detail: `${payload.delivered_citation_ids.length} citation(s); ${payload.delivered_node_ids.length} node(s); surface:${payload.delivery_surface}`,
      outcome: "succeeded",
      source: sourceOf(event),
    };
  }

  if (payload.event_type === "memory.recall.observed") {
    return {
      id: event.id,
      occurred_at: event.occurred_at,
      kind: event.kind,
      session_id: sessionIdOf(event),
      actor: actorOf(event),
      title: "recall observed",
      detail: `${payload.returned_count}/${payload.candidate_count} candidate(s); ${payload.tokens_saved} tokens saved; surface:${payload.surface}`,
      outcome: payload.hit ? "succeeded" : "noop",
      source: sourceOf(event),
    };
  }

  return {
    id: event.id,
    occurred_at: event.occurred_at,
    kind: event.kind,
    session_id: sessionIdOf(event),
    actor: actorOf(event),
    title: `${payload.name} ${payload.event_type}`,
    detail: skillDetail(payload),
    outcome: skillOutcome(payload.result?.status),
    source: sourceOf(event),
  };
}

function engineOutcome(outcome: string): SessionTimelineEntry["outcome"] {
  if (outcome === "failed") return "failed";
  if (outcome === "miss") return "noop";
  return "succeeded";
}

function skillOutcome(status: string | undefined): SessionTimelineEntry["outcome"] {
  if (status === "failed") return "failed";
  if (status === "succeeded") return "succeeded";
  return "unknown";
}

function skillDetail(payload: Extract<MemoryEvent["payload"], { event_type: "result" | "viewed" | "used" | "changed" | "patched" }>): string {
  const parts = [
    payload.source_kind,
    payload.path,
    payload.result?.duration_ms != null ? `${payload.result.duration_ms}ms` : null,
    payload.result?.error_stage,
    payload.result?.error_class,
  ].filter((part): part is string => Boolean(part));
  return parts.join("; ");
}

function summarizeSessions(entries: SessionTimelineEntry[]): SessionTimeline["sessions"] {
  const bySession = new Map<string, SessionTimelineEntry[]>();
  for (const entry of entries) {
    const list = bySession.get(entry.session_id) ?? [];
    list.push(entry);
    bySession.set(entry.session_id, list);
  }
  return [...bySession.entries()]
    .map(([session_id, list]) => ({
      session_id,
      events: list.length,
      first_event_at: list[0]?.occurred_at ?? "",
      last_event_at: list.at(-1)?.occurred_at ?? "",
    }))
    .sort((a, b) => a.last_event_at.localeCompare(b.last_event_at));
}

function timelineActions(entries: SessionTimelineEntry[], sessionId?: string): string[] {
  if (entries.length === 0) {
    return [
      sessionId
        ? `no events found for session ${sessionId}; verify hooks are enabled and firing`
        : "no session events found; run `memory hooks coverage` and enable lifecycle hooks",
    ];
  }
  const actions: string[] = [];
  if (!entries.some((entry) => entry.kind === "hook.lifecycle")) {
    actions.push("no hook lifecycle events in this window; run `memory hooks coverage`");
  }
  if (entries.some((entry) => entry.outcome === "failed")) {
    actions.push("review failed timeline entries before relying on this session handoff");
  }
  if (actions.length === 0) actions.push("Memory session timeline is ready");
  return actions;
}

function sessionIdOf(event: MemoryEvent): string {
  return typeof event.scope.id === "string" ? event.scope.id : "unknown";
}

function actorOf(event: MemoryEvent): string {
  return typeof event.actor.id === "string" ? event.actor.id : event.actor.name ?? event.actor.kind;
}

function sourceOf(event: MemoryEvent): string {
  return event.provenance.hook ?? event.provenance.command ?? event.source.name ?? event.source.kind;
}
