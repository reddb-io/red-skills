import { z } from "zod";
import type { QueryParam } from "@reddb-io/sdk";
import type { MemoryStore } from "./graph-store.js";
import { COLLECTIONS } from "./schema.js";
import type { SkillEvent } from "./skill-events.js";
import type { HookResult, NormalizedInput } from "./hook-runtime.js";

const SAFE_TEXT_MAX = 512;
const SAFE_PATH_MAX = 2048;

const safeString = (label: string, max = SAFE_TEXT_MAX) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} is too large`);

const envelopeObject = (label: string) =>
  z
    .object({
      kind: safeString(`${label}.kind`, 120),
      id: safeString(`${label}.id`, 240).optional(),
      name: safeString(`${label}.name`, 240).optional(),
    })
    .catchall(z.unknown());

const skillTelemetryPayloadSchema = z
  .object({
    event_type: z.enum(["viewed", "used", "result", "changed", "patched"]),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    session_id: safeString("payload.session_id", 200),
    turn_id: safeString("payload.turn_id", 200),
    name: safeString("payload.name", 200),
    source_kind: safeString("payload.source_kind", 80),
    path: safeString("payload.path", SAFE_PATH_MAX),
    runner: safeString("payload.runner", 80),
    result: z
      .object({
        status: z.enum(["succeeded", "failed", "abandoned", "blocked", "unknown"]),
        duration_ms: z.number().int().nonnegative().max(86_400_000).optional(),
        error_class: safeString("payload.result.error_class", 160).optional(),
        error_code: safeString("payload.result.error_code", 160).optional(),
        error_stage: safeString("payload.result.error_stage", 160).optional(),
      })
      .strict()
      .optional(),
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

const engineOpPayloadSchema = z
  .object({
    event_type: z.literal("engine.op"),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    op: z.enum(["store", "recall", "promote", "evict", "conflict-detected"]),
    layer: z.enum(["L1", "L2", "L3"]).optional(),
    session_id: safeString("payload.session_id", 200).optional(),
    node_id: safeString("payload.node_id", 200).optional(),
    query: safeString("payload.query", SAFE_TEXT_MAX).optional(),
    outcome: z.enum([
      "created",
      "deduped",
      "hit",
      "miss",
      "succeeded",
      "failed",
    ]),
    hit_count: z.number().int().nonnegative().max(1_000_000).optional(),
    error: safeString("payload.error", 400).optional(),
  })
  .strict();

const hookLifecyclePayloadSchema = z
  .object({
    event_type: z.literal("hook.lifecycle"),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    session_id: safeString("payload.session_id", 200).optional(),
    runner: z.enum(["claude", "codex"]),
    hook_event: z.enum(["SessionStart", "PostToolUse", "Stop", "PreCompact"]),
    cwd: safeString("payload.cwd", SAFE_PATH_MAX).optional(),
    changed_files: z.array(safeString("payload.changed_files", SAFE_PATH_MAX)).max(200),
    transcript_chars: z.number().int().nonnegative().max(10_000_000).optional(),
    result: z
      .object({
        noop: z.boolean(),
        reason: safeString("payload.result.reason", 240).optional(),
        stored: z.number().int().nonnegative().max(100_000).optional(),
        indexed: z.number().int().nonnegative().max(100_000).optional(),
        injected_chars: z.number().int().nonnegative().max(10_000_000).optional(),
      })
      .strict(),
  })
  .strict();

const provenanceSchema = z
  .object({
    source_kind: z.enum(["manual", "hook", "derived", "system"]),
    writer: safeString("provenance.writer", 160).optional(),
    command: safeString("provenance.command", 240).optional(),
    hook: safeString("provenance.hook", 240).optional(),
    evidence: z.array(safeString("provenance.evidence", 400)).max(20).optional(),
  })
  .catchall(z.unknown());

const memoryEventSchema = z
  .object({
    id: safeString("id", 240),
    occurred_at: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    kind: z.enum(["skill.telemetry", "hook.lifecycle", "engine.op"]),
    source: envelopeObject("source"),
    actor: envelopeObject("actor"),
    scope: z
      .object({
        level: safeString("scope.level", 120),
        id: safeString("scope.id", 240).optional(),
      })
      .catchall(z.unknown()),
    subject: envelopeObject("subject"),
    payload: z.union([
      skillTelemetryPayloadSchema,
      hookLifecyclePayloadSchema,
      engineOpPayloadSchema,
    ]),
    provenance: provenanceSchema,
  })
  .strict();

export type MemoryEvent = z.infer<typeof memoryEventSchema>;
export type SkillTelemetryPayload = z.infer<typeof skillTelemetryPayloadSchema>;
export type HookLifecyclePayload = z.infer<typeof hookLifecyclePayloadSchema>;
export type EngineOpPayload = z.infer<typeof engineOpPayloadSchema>;
export type EngineOp = EngineOpPayload["op"];
export type EngineOpOutcome = EngineOpPayload["outcome"];

export interface EngineOpInput {
  op: EngineOp;
  outcome: EngineOpOutcome;
  layer?: EngineOpPayload["layer"];
  session_id?: string;
  node_id?: string | number;
  query?: string;
  hit_count?: number;
  error?: string;
  timestamp?: string | Date;
  eventId?: string;
}

export interface MemoryEventReadOptions {
  /** Retention horizon in milliseconds. When absent, all raw events are returned. */
  retentionMs?: number;
  /** Evaluation time for retention. Defaults to the current wall clock. */
  now?: string | number | Date;
}

export function parseMemoryEvent(input: unknown): MemoryEvent {
  const parsed = memoryEventSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const detail = parsed.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "event";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  throw new Error(`invalid memory event: ${detail}`);
}

export function skillEventToMemoryEvent(event: SkillEvent): MemoryEvent {
  return parseMemoryEvent({
    id: `skill-event:${event.event_id}`,
    occurred_at: event.timestamp,
    kind: "skill.telemetry",
    source: { kind: "hook", name: "memory event skill" },
    actor: { kind: "agent", id: event.runner },
    scope: { level: "session", id: event.session_id },
    subject: { kind: "skill", id: `${event.source_kind}:${event.name}` },
    payload: event,
    provenance: {
      source_kind: "hook",
      writer: "memory",
      command: "memory event skill",
      evidence: [`event_id:${event.event_id}`],
    },
  });
}

export function hookLifecycleToMemoryEvent(
  input: NormalizedInput,
  result: HookResult,
  opts: { timestamp?: string | Date; eventId?: string } = {},
): MemoryEvent {
  const timestamp =
    opts.timestamp instanceof Date
      ? opts.timestamp.toISOString()
      : opts.timestamp ?? new Date().toISOString();
  const sessionId = input.sessionId ?? `cwd:${input.cwd ?? "unknown"}`;
  const eventId =
    opts.eventId ??
    `hook:${input.runner}:${input.event}:${sessionId}:${Date.parse(timestamp) || timestamp}`;
  return parseMemoryEvent({
    id: eventId,
    occurred_at: timestamp,
    kind: "hook.lifecycle",
    source: { kind: "hook", name: input.event },
    actor: { kind: "agent", id: input.runner },
    scope: { level: "session", id: sessionId },
    subject: { kind: "hook", id: input.event },
    payload: {
      event_type: "hook.lifecycle",
      event_id: eventId,
      timestamp,
      session_id: input.sessionId,
      runner: input.runner,
      hook_event: input.event,
      cwd: input.cwd,
      changed_files: input.changedFiles,
      transcript_chars: input.transcriptText?.length,
      result: {
        noop: result.noop,
        reason: result.reason,
        stored: result.stored,
        indexed: result.indexed,
        injected_chars: result.inject?.length,
      },
    },
    provenance: {
      source_kind: "hook",
      writer: "memory",
      command: "memory hook",
      hook: input.event,
      evidence: [`event_id:${eventId}`],
    },
  });
}

export function engineOpToMemoryEvent(input: EngineOpInput): MemoryEvent {
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : input.timestamp ?? new Date().toISOString();
  const nodeId = input.node_id == null ? undefined : String(input.node_id);
  const eventId =
    input.eventId ??
    `engine:${input.op}:${nodeId ?? input.query ?? "anon"}:${Date.parse(timestamp) || timestamp}`;
  const sessionId = input.session_id ?? `engine:${input.op}`;
  return parseMemoryEvent({
    id: eventId,
    occurred_at: timestamp,
    kind: "engine.op",
    source: { kind: "engine", name: "memory.engine" },
    actor: { kind: "engine", id: "memory" },
    scope: { level: "session", id: sessionId },
    subject: { kind: "engine-op", id: input.op, name: nodeId ?? input.query },
    payload: {
      event_type: "engine.op",
      event_id: eventId,
      timestamp,
      op: input.op,
      ...(input.layer ? { layer: input.layer } : {}),
      ...(input.session_id ? { session_id: input.session_id } : {}),
      ...(nodeId ? { node_id: nodeId } : {}),
      ...(input.query ? { query: input.query } : {}),
      outcome: input.outcome,
      ...(input.hit_count != null ? { hit_count: input.hit_count } : {}),
      ...(input.error ? { error: input.error } : {}),
    },
    provenance: {
      source_kind: "system",
      writer: "memory",
      command: `engine.${input.op}`,
      evidence: [`event_id:${eventId}`],
    },
  });
}

/**
 * Best-effort engine event append. Engine ops emit telemetry via this entry
 * point and must never see an exception — failure to record telemetry must
 * not fail the engine operation that triggered it (issue #181).
 */
export async function appendEngineOpEvent(
  store: MemoryStore,
  input: EngineOpInput,
): Promise<void> {
  try {
    await appendMemoryEvent(store, engineOpToMemoryEvent(input));
  } catch {
    // Swallowed by design — see function docs.
  }
}

export async function appendMemoryEvent(
  store: MemoryStore,
  event: MemoryEvent,
): Promise<void> {
  const parsed = parseMemoryEvent(event);
  await ensureMemoryEventsCollection(store);
  await store.raw.query(
    `INSERT INTO ${COLLECTIONS.events} (id, occurred_at, event_kind, source, actor, scope, subject, payload, provenance) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    parsed.id,
    parsed.occurred_at,
    parsed.kind,
    parsed.source as QueryParam,
    parsed.actor as QueryParam,
    parsed.scope as QueryParam,
    parsed.subject as QueryParam,
    parsed.payload as QueryParam,
    parsed.provenance as QueryParam,
  );
}

export async function readMemoryEvents(
  store: MemoryStore,
  opts: MemoryEventReadOptions = {},
): Promise<MemoryEvent[]> {
  await ensureMemoryEventsCollection(store);
  const result = await store.raw.query(`SELECT * FROM ${COLLECTIONS.events} ORDER BY rid ASC`);
  const events = result.rows.map(rowToMemoryEvent);
  const cutoff = retentionCutoffMs(opts);
  return cutoff == null
    ? events
    : events.filter((event) => Date.parse(event.occurred_at) >= cutoff);
}

async function ensureMemoryEventsCollection(store: MemoryStore): Promise<void> {
  await store.raw.execute(
    `CREATE TABLE IF NOT EXISTS ${COLLECTIONS.events} (id TEXT, occurred_at TEXT, event_kind TEXT, source JSON, actor JSON, scope JSON, subject JSON, payload JSON, provenance JSON) APPEND ONLY`,
  );
}

function rowToMemoryEvent(row: Record<string, unknown>): MemoryEvent {
  return parseMemoryEvent({
    id: row.id ?? row.ID,
    occurred_at: row.occurred_at ?? row.OCCURRED_AT,
    kind: row.event_kind ?? row.EVENT_KIND,
    source: parseJsonColumn(row.source ?? row.SOURCE),
    actor: parseJsonColumn(row.actor ?? row.ACTOR),
    scope: parseJsonColumn(row.scope ?? row.SCOPE),
    subject: parseJsonColumn(row.subject ?? row.SUBJECT),
    payload: parseJsonColumn(row.payload ?? row.PAYLOAD),
    provenance: parseJsonColumn(row.provenance ?? row.PROVENANCE),
  });
}

function parseJsonColumn(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function retentionCutoffMs(opts: MemoryEventReadOptions): number | null {
  if (opts.retentionMs == null) return null;
  if (!Number.isFinite(opts.retentionMs) || opts.retentionMs < 0) {
    throw new Error("memory event retentionMs must be a non-negative number");
  }
  const now = opts.now == null ? Date.now() : new Date(opts.now).getTime();
  if (!Number.isFinite(now)) {
    throw new Error("memory event retention now must be a valid date");
  }
  return now - opts.retentionMs;
}
