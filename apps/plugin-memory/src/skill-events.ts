import { z } from "zod";
import { contentHash } from "./hash.js";
import type { MemoryNode } from "./schema.js";
import type { MemoryStore } from "./graph-store.js";
import { appendMemoryEvent, skillEventToMemoryEvent } from "./memory-events.js";

const SAFE_TEXT_MAX = 512;
const SAFE_PATH_MAX = 2048;

const safeString = (label: string, max = SAFE_TEXT_MAX) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is too large`);

export const SKILL_EVENT_TYPES = ["viewed", "used", "result", "changed", "patched"] as const;
export const SKILL_RESULT_STATUSES = [
  "succeeded",
  "failed",
  "abandoned",
  "blocked",
  "unknown",
] as const;

export type SkillEventType = (typeof SKILL_EVENT_TYPES)[number];
export type SkillResultStatus = (typeof SKILL_RESULT_STATUSES)[number];

const resultSchema = z
  .object({
    status: z.enum(SKILL_RESULT_STATUSES),
    duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
    error_class: safeString("error_class", 160).optional(),
    error_code: safeString("error_code", 160).optional(),
    error_stage: safeString("error_stage", 160).optional(),
  })
  .strict();

const eventSchema = z
  .object({
    event_type: z.enum(SKILL_EVENT_TYPES),
    event_id: safeString("event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    session_id: safeString("session_id", 200),
    turn_id: safeString("turn_id", 200),
    name: safeString("name", 200),
    source_kind: safeString("source_kind", 80),
    path: safeString("path", SAFE_PATH_MAX),
    runner: safeString("runner", 80),
    result: resultSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.event_type === "result" && !event.result) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "result events require a safe result payload",
      });
    }
    if (event.event_type !== "result" && event.result) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["result"],
        message: "result payloads are only valid on result events",
      });
    }
  });

export type SkillEvent = z.infer<typeof eventSchema>;

export interface SkillEventIngestReport {
  events: number;
  nodes: number;
  edges: number;
}

export interface SkillRollup {
  name: string;
  source_kind: string;
  path: string;
  first_seen: string;
  last_activity: string;
  event_count: number;
  view_count: number;
  use_count: number;
  patch_count: number;
  change_count: number;
  result_count: number;
  outcome_counts: Partial<Record<SkillResultStatus, number>>;
  curatable_status: "active";
  archive_signal: boolean;
  consolidation_signal: boolean;
}

export function parseSkillEventInput(input: string): SkillEvent[] {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("skill event input is empty");

  const raw = parseJsonOrJsonl(trimmed);
  const events = Array.isArray(raw) ? raw : [raw];
  if (events.length === 0) throw new Error("skill event batch is empty");
  return events.map((event, index) => parseSkillEvent(event, index));
}

export function parseSkillEvent(input: unknown, index = 0): SkillEvent {
  const parsed = eventSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : `event[${index}]`;
      const extras =
        "keys" in issue && Array.isArray(issue.keys) ? ` (${issue.keys.join(", ")})` : "";
      return `${path}: ${issue.message}${extras}`;
    })
    .join("; ");
  throw new Error(`invalid skill event: ${detail}`);
}

export async function ingestSkillEvents(
  store: MemoryStore,
  events: readonly SkillEvent[],
): Promise<SkillEventIngestReport> {
  const touchedNodes = new Set<number>();
  const touchedEdges = new Set<number>();

  for (const event of events) {
    await appendMemoryEvent(store, skillEventToMemoryEvent(event));

    const graph = await upsertSkillEventGraph(store, event);
    for (const rid of graph.nodes) touchedNodes.add(rid);
    for (const rid of graph.edges) touchedEdges.add(rid);

    if (!(await hasSeenEventId(store, event.event_id))) {
      const rollup = await readSkillRollup(store, event);
      updateSkillRollup(rollup, event);
      await writeSkillRollup(store, event, rollup[skillRollupKey(event)]);
      await writeSeenEventId(store, event.event_id);
    }
  }

  return { events: events.length, nodes: touchedNodes.size, edges: touchedEdges.size };
}

export async function readSkillRollups(store: MemoryStore): Promise<SkillRollup[]> {
  const rollups = await readSkillRollupMap(store);
  return Object.values(rollups).sort((a, b) => a.name.localeCompare(b.name));
}

/** A flattened, read-only view of a stored skill-event node for status output. */
export interface SkillEventSummary {
  event_type: SkillEventType;
  event_id: string;
  name: string;
  source_kind: string;
  path: string;
  runner: string;
  timestamp: string;
  status?: SkillResultStatus;
  error_class?: string;
  error_code?: string;
  error_stage?: string;
}

/**
 * The most recent skill-event nodes, newest first. Reads the persisted
 * `skill_event` payload off graph nodes (validated again on the way out, so a
 * malformed node is skipped rather than throwing) and returns at most `limit`.
 * Read-only — it never mutates the store.
 */
export async function readRecentSkillEvents(
  store: MemoryStore,
  limit = 10,
): Promise<SkillEventSummary[]> {
  const nodes = await store.listNodes();
  const events: SkillEvent[] = [];
  for (const node of nodes) {
    if (!node.label.startsWith("skill-event:")) continue;
    const raw = (node.properties as Record<string, unknown> | undefined)?.skill_event;
    const parsed = eventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
  }
  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return events.slice(0, Math.max(0, limit)).map((e) => ({
    event_type: e.event_type,
    event_id: e.event_id,
    name: e.name,
    source_kind: e.source_kind,
    path: e.path,
    runner: e.runner,
    timestamp: e.timestamp,
    status: e.result?.status,
    error_class: e.result?.error_class,
    error_code: e.result?.error_code,
    error_stage: e.result?.error_stage,
  }));
}

export function skillEventToNode(event: SkillEvent): MemoryNode {
  const result = event.result;
  const resultSummary = result
    ? ` result=${result.status}${result.duration_ms != null ? ` duration=${result.duration_ms}ms` : ""}`
    : "";
  const title = `${event.name} ${event.event_type}`;
  return {
    label: `skill-event:${event.event_id}`,
    node_type: "workflow",
    properties: {
      title,
      summary: `${event.runner} ${event.event_type} ${event.name}${resultSummary}`,
      content:
        `${event.timestamp} ${event.runner} ${event.event_type} ` +
        `${event.name} (${event.path})${resultSummary}`,
      tags: ["skill-telemetry", `skill:${event.name}`, `runner:${event.runner}`],
      confidence: "EXTRACTED",
      source: "skill-telemetry",
      hash: contentHash("skill-event", event.event_id),
      skill_event: event,
    },
  };
}

function skillToNode(event: SkillEvent): MemoryNode {
  return {
    label: `skill:${event.name}`,
    node_type: "workflow",
    properties: {
      title: event.name,
      summary: `${event.source_kind} skill at ${event.path}`,
      content: `${event.name} (${event.source_kind}) ${event.path}`,
      tags: ["skill-telemetry", "skill", `source:${event.source_kind}`],
      confidence: "EXTRACTED",
      source: "skill-telemetry",
      hash: contentHash("skill", event.name, event.source_kind, event.path),
      skill: {
        name: event.name,
        source_kind: event.source_kind,
        path: event.path,
      },
    },
  };
}

function sessionToNode(event: SkillEvent): MemoryNode {
  return {
    label: `skill-session:${event.session_id}`,
    node_type: "session",
    properties: {
      title: `skill session ${event.session_id}`,
      summary: `${event.runner} skill telemetry session`,
      content: `${event.runner} session ${event.session_id}`,
      tags: ["skill-telemetry", `runner:${event.runner}`],
      confidence: "EXTRACTED",
      source: "skill-telemetry",
      tier: "durable",
      hash: contentHash("skill-session", event.session_id, event.runner),
      skill_session: {
        session_id: event.session_id,
        runner: event.runner,
      },
    },
  };
}

function turnToNode(event: SkillEvent): MemoryNode {
  return {
    label: `skill-turn:${event.turn_id}`,
    node_type: "task",
    properties: {
      title: `skill turn ${event.turn_id}`,
      summary: `${event.runner} turn ${event.turn_id}`,
      content: `${event.runner} session ${event.session_id} turn ${event.turn_id}`,
      tags: ["skill-telemetry", `runner:${event.runner}`],
      confidence: "EXTRACTED",
      source: "skill-telemetry",
      hash: contentHash("skill-turn", event.session_id, event.turn_id, event.runner),
      skill_turn: {
        session_id: event.session_id,
        turn_id: event.turn_id,
        runner: event.runner,
      },
    },
  };
}

async function upsertSkillEventGraph(
  store: MemoryStore,
  event: SkillEvent,
): Promise<{ nodes: number[]; edges: number[] }> {
  const skillRid = await store.upsertNode(skillToNode(event));
  const sessionRid = await store.upsertNode(sessionToNode(event));
  const turnRid = await store.upsertNode(turnToNode(event));
  const eventRid = await store.upsertNode(skillEventToNode(event));

  const edges = [
    await store.upsertEdge({
      label: "CONTAINS",
      from_rid: skillRid,
      to_rid: eventRid,
      properties: { source: "skill-telemetry", reason: "skill observed event" },
    }),
    await store.upsertEdge({
      label: "CONTAINS",
      from_rid: sessionRid,
      to_rid: turnRid,
      properties: { source: "skill-telemetry", reason: "session contains turn" },
    }),
    await store.upsertEdge({
      label: "CONTAINS",
      from_rid: turnRid,
      to_rid: eventRid,
      properties: { source: "skill-telemetry", reason: "turn contains event" },
    }),
    await store.upsertEdge({
      label: "REFERENCES",
      from_rid: eventRid,
      to_rid: skillRid,
      properties: { source: "skill-telemetry", reason: "event references skill" },
    }),
  ];

  return { nodes: [skillRid, sessionRid, turnRid, eventRid], edges };
}

async function hasSeenEventId(store: MemoryStore, eventId: string): Promise<boolean> {
  return (await store.kvGet<true>(skillEventSeenKey(eventId))) === true;
}

async function writeSeenEventId(store: MemoryStore, eventId: string): Promise<void> {
  await store.kvPut(skillEventSeenKey(eventId), true);
}

async function readSkillRollup(
  store: MemoryStore,
  event: SkillEvent,
): Promise<Record<string, SkillRollup>> {
  const partitioned = await store.kvGet<SkillRollup | string>(skillRollupStorageKey(event));
  if (partitioned == null) return {};
  return { [skillRollupKey(event)]: parseKvValue<SkillRollup>(partitioned) };
}

async function writeSkillRollup(
  store: MemoryStore,
  event: SkillEvent,
  rollup: SkillRollup,
): Promise<void> {
  await store.kvPut(skillRollupStorageKey(event), rollup);
}

async function readSkillRollupMap(store: MemoryStore): Promise<Record<string, SkillRollup>> {
  const rollups: Record<string, SkillRollup> = {};
  const nodes = await store.listNodes();
  for (const node of nodes) {
    const skill = (node.properties as Record<string, unknown> | undefined)?.skill;
    if (!isStoredSkill(skill)) continue;
    const stored = await store.kvGet<SkillRollup | string>(skillRollupStorageKey(skill));
    if (stored == null) continue;
    rollups[skillRollupKey(skill)] = parseKvValue<SkillRollup>(stored);
  }
  return rollups;
}

function parseKvValue<T>(raw: T | string): T {
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as T;
}

function updateSkillRollup(rollups: Record<string, SkillRollup>, event: SkillEvent): void {
  const key = skillRollupKey(event);
  const current =
    rollups[key] ??
    ({
      name: event.name,
      source_kind: event.source_kind,
      path: event.path,
      first_seen: event.timestamp,
      last_activity: event.timestamp,
      event_count: 0,
      view_count: 0,
      use_count: 0,
      patch_count: 0,
      change_count: 0,
      result_count: 0,
      outcome_counts: {},
      curatable_status: "active",
      archive_signal: false,
      consolidation_signal: false,
    } satisfies SkillRollup);

  current.event_count += 1;
  current.first_seen = earlierTimestamp(current.first_seen, event.timestamp);
  current.last_activity = laterTimestamp(current.last_activity, event.timestamp);

  switch (event.event_type) {
    case "viewed":
      current.view_count += 1;
      break;
    case "used":
      current.use_count += 1;
      break;
    case "patched":
      current.patch_count += 1;
      break;
    case "changed":
      current.change_count += 1;
      break;
    case "result": {
      current.result_count += 1;
      const status = event.result?.status ?? "unknown";
      current.outcome_counts[status] = (current.outcome_counts[status] ?? 0) + 1;
      break;
    }
  }

  rollups[key] = current;
}

function skillRollupKey(skill: Pick<SkillEvent, "source_kind" | "name" | "path">): string {
  return `${skill.source_kind}:${skill.name}:${skill.path}`;
}

function skillRollupStorageKey(skill: Pick<SkillEvent, "source_kind" | "name" | "path">): string {
  return `skill-rollup:${contentHash(skill.source_kind, skill.name, skill.path)}`;
}

function skillEventSeenKey(eventId: string): string {
  return `skill-event-seen:${contentHash(eventId)}`;
}

function isStoredSkill(input: unknown): input is Pick<SkillEvent, "source_kind" | "name" | "path"> {
  if (input == null || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.source_kind === "string" &&
    typeof value.name === "string" &&
    typeof value.path === "string"
  );
}

function earlierTimestamp(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function laterTimestamp(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function parseJsonOrJsonl(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (jsonErr) {
    const lines = input
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= 1) throw jsonErr;
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(
          `invalid JSONL at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
