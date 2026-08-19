import { createHash } from "node:crypto";
import { z } from "zod";
import type { QueryParam } from "@reddb-io/sdk";
import type { ContextPack } from "./context-pack.js";
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

const driftCaughtPayloadSchema = z
  .object({
    event_type: z.literal("memory.drift.caught"),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    /** Watched paths that changed in the PR without an audit marker. */
    changed_paths: z.array(safeString("payload.changed_paths", SAFE_PATH_MAX)).min(1).max(200),
    /** The documented actionable line the guard printed when it failed the PR. */
    reason: safeString("payload.reason", SAFE_TEXT_MAX),
    pr_number: safeString("payload.pr_number", 80).optional(),
    head_sha: safeString("payload.head_sha", 80).optional(),
    base_ref: safeString("payload.base_ref", 240).optional(),
  })
  .strict();

const contextPackGenerationPayloadSchema = z
  .object({
    event_type: z.literal("memory.context-pack.generated"),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    goal: safeString("payload.goal", SAFE_TEXT_MAX),
    pack_id: safeString("payload.pack_id", 240),
    surface: safeString("payload.surface", 120),
    status: z.enum(["ok", "insufficient-context"]),
    citation_ids: z.array(safeString("payload.citation_ids", 240)).max(1_000),
    node_ids: z.array(z.number().int().positive()).max(1_000),
    budget_chars: z.number().int().nonnegative().max(10_000_000),
    used_chars: z.number().int().nonnegative().max(10_000_000),
    entry_count: z.number().int().nonnegative().max(1_000_000),
    core_context_count: z.number().int().nonnegative().max(1_000_000),
    warning_count: z.number().int().nonnegative().max(1_000_000),
    omitted_entries: z.number().int().nonnegative().max(1_000_000),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

const memoryInjectionPayloadSchema = z
  .object({
    event_type: z.literal("memory.injection.delivered"),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    delivery_surface: safeString("payload.delivery_surface", 120),
    delivered_citation_ids: z.array(safeString("payload.delivered_citation_ids", 240)).max(1_000),
    delivered_node_ids: z.array(z.number().int().positive()).max(1_000),
    goal: safeString("payload.goal", SAFE_TEXT_MAX).optional(),
    pack_id: safeString("payload.pack_id", 240).optional(),
    session_id: safeString("payload.session_id", 200).optional(),
    runner: safeString("payload.runner", 80).optional(),
    hook_event: safeString("payload.hook_event", 120).optional(),
    injected_chars: z.number().int().nonnegative().max(10_000_000).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((payload, ctx) => {
    if (payload.delivered_citation_ids.length === 0 && payload.delivered_node_ids.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["delivered_citation_ids"],
        message: "memory injection observations require delivered citation or node ids",
      });
    }
  });

const recallObservationPayloadSchema = z
  .object({
    event_type: z.literal("memory.recall.observed"),
    event_id: safeString("payload.event_id", 200),
    timestamp: z
      .string()
      .datetime({ offset: true })
      .or(z.string().datetime({ offset: false })),
    /** Surface that drove the recall (e.g. "context-pack", "handoff", "cli"). */
    surface: safeString("payload.surface", 120),
    query: safeString("payload.query", SAFE_TEXT_MAX).optional(),
    session_id: safeString("payload.session_id", 200).optional(),
    runner: safeString("payload.runner", 80).optional(),
    /** Total governed candidates recall produced (returned + budget-omitted). */
    candidate_count: z.number().int().nonnegative().max(1_000_000),
    /** Candidates that survived into the delivered pack. */
    returned_count: z.number().int().nonnegative().max(1_000_000),
    /** Whether recall returned at least one governed candidate. */
    hit: z.boolean(),
    hit_count: z.number().int().nonnegative().max(1_000_000),
    /** Proxy for "the most-important fact made the pack": a pinned/core entry
     * survived budgeting (or nothing valuable was dropped). */
    gold_in_pack_proxy: z.boolean(),
    gold_proxy_rank: z.number().int().positive().max(1_000_000).optional(),
    /** Estimated tokens for the full recalled content before budgeting. */
    tokens_baseline: z.number().int().nonnegative().max(10_000_000),
    /** Estimated tokens actually delivered in the pack. */
    tokens_compressed: z.number().int().nonnegative().max(10_000_000),
    /** Tokens saved versus delivering the full recalled content. */
    tokens_saved: z.number().int().nonnegative().max(10_000_000),
    metadata: z.record(z.unknown()).optional(),
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
    kind: z.enum([
      "skill.telemetry",
      "hook.lifecycle",
      "engine.op",
      "memory.drift.caught",
      "memory.context-pack.generated",
      "memory.injection.delivered",
      "memory.recall.observed",
    ]),
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
      driftCaughtPayloadSchema,
      contextPackGenerationPayloadSchema,
      memoryInjectionPayloadSchema,
      recallObservationPayloadSchema,
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
export type DriftCaughtPayload = z.infer<typeof driftCaughtPayloadSchema>;
export type ContextPackGenerationPayload = z.infer<typeof contextPackGenerationPayloadSchema>;
export type MemoryInjectionPayload = z.infer<typeof memoryInjectionPayloadSchema>;
export type RecallObservationPayload = z.infer<typeof recallObservationPayloadSchema>;

export interface DriftCaughtInput {
  /** Watched paths that changed without an audit marker. Must be non-empty. */
  changedPaths: readonly string[];
  /** The documented actionable line the guard failed the PR with. */
  reason: string;
  prNumber?: string;
  headSha?: string;
  baseRef?: string;
  timestamp?: string | Date;
  eventId?: string;
}

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

export interface ContextPackGenerationInput {
  pack: ContextPack;
  surface: string;
  timestamp?: string | Date;
  eventId?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryInjectionInput {
  deliveredCitationIds?: readonly string[];
  deliveredNodeIds?: readonly (string | number)[];
  deliverySurface: string;
  goal?: string;
  packId?: string;
  sessionId?: string;
  runner?: string;
  hookEvent?: string;
  injectedChars?: number;
  timestamp?: string | Date;
  eventId?: string;
  metadata?: Record<string, unknown>;
}

export interface RecallObservationInput {
  surface: string;
  query?: string;
  sessionId?: string;
  runner?: string;
  candidateCount: number;
  returnedCount: number;
  hitCount: number;
  goldInPackProxy: boolean;
  goldProxyRank?: number;
  tokensBaseline: number;
  tokensCompressed: number;
  timestamp?: string | Date;
  eventId?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryInjectionRollup {
  id: string;
  delivered_count: number;
  last_injected_at: string;
  delivery_surfaces: string[];
  citation_id?: string;
  node_id?: number;
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

export function contextPackIdentity(pack: ContextPack): string {
  const citationIds = pack.entries.map((entry) => entry.citation.urn).sort();
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        goal: pack.goal,
        status: pack.status,
        budgetChars: pack.budgetChars,
        usedChars: pack.usedChars,
        citationIds,
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `context-pack:${hash}`;
}

export function contextPackGenerationToMemoryEvent(
  input: ContextPackGenerationInput,
): MemoryEvent {
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : input.timestamp ?? new Date().toISOString();
  const packId = contextPackIdentity(input.pack);
  const eventId =
    input.eventId ?? `context-pack:${input.surface}:${packId}:${Date.parse(timestamp) || timestamp}`;
  const citationIds = input.pack.entries.map((entry) => entry.citation.urn);
  const nodeIds = input.pack.entries.map((entry) => entry.citation.rid);
  return parseMemoryEvent({
    id: eventId,
    occurred_at: timestamp,
    kind: "memory.context-pack.generated",
    source: { kind: "memory", name: "memory.context-pack" },
    actor: { kind: "agent", id: input.surface },
    scope: { level: "goal", id: input.pack.goal },
    subject: { kind: "context-pack", id: packId },
    payload: {
      event_type: "memory.context-pack.generated",
      event_id: eventId,
      timestamp,
      goal: input.pack.goal,
      pack_id: packId,
      surface: input.surface,
      status: input.pack.status,
      citation_ids: citationIds,
      node_ids: nodeIds,
      budget_chars: input.pack.budgetChars,
      used_chars: input.pack.usedChars,
      entry_count: input.pack.entries.length,
      core_context_count: input.pack.coreContext.length,
      warning_count: input.pack.warnings.length,
      omitted_entries: input.pack.omittedEntries,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    provenance: {
      source_kind: "system",
      writer: "memory",
      command: "memory context-pack",
      evidence: [`event_id:${eventId}`, `pack_id:${packId}`],
    },
  });
}

export function memoryInjectionToMemoryEvent(input: MemoryInjectionInput): MemoryEvent {
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : input.timestamp ?? new Date().toISOString();
  const deliveredCitationIds = [...(input.deliveredCitationIds ?? [])];
  const deliveredNodeIds = [...(input.deliveredNodeIds ?? [])].map((id) => Number(id));
  const identity =
    input.packId ?? deliveredCitationIds[0] ?? deliveredNodeIds[0]?.toString() ?? "unknown";
  const eventId =
    input.eventId ??
    `injection:${input.deliverySurface}:${identity}:${Date.parse(timestamp) || timestamp}`;
  return parseMemoryEvent({
    id: eventId,
    occurred_at: timestamp,
    kind: "memory.injection.delivered",
    source: { kind: "memory", name: "memory.injection" },
    actor: { kind: "agent", id: input.runner ?? input.deliverySurface },
    scope: { level: input.sessionId ? "session" : "delivery", id: input.sessionId ?? input.deliverySurface },
    subject: { kind: "memory-injection", id: identity },
    payload: {
      event_type: "memory.injection.delivered",
      event_id: eventId,
      timestamp,
      delivery_surface: input.deliverySurface,
      delivered_citation_ids: deliveredCitationIds,
      delivered_node_ids: deliveredNodeIds,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.packId ? { pack_id: input.packId } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.runner ? { runner: input.runner } : {}),
      ...(input.hookEvent ? { hook_event: input.hookEvent } : {}),
      ...(input.injectedChars != null ? { injected_chars: input.injectedChars } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    provenance: {
      source_kind: input.deliverySurface === "hook" ? "hook" : "system",
      writer: "memory",
      command: "memory injection",
      ...(input.hookEvent ? { hook: input.hookEvent } : {}),
      evidence: [`event_id:${eventId}`],
    },
  });
}

/**
 * Build a `memory.recall.observed` event (PRD #820, issue #828). Emitted from
 * real agent runs so recall hit-rate, gold-in-pack proxy, and tokens-saved are
 * observable in the analytics hypertable alongside the synthetic benchmark.
 */
export function recallObservationToMemoryEvent(
  input: RecallObservationInput,
): MemoryEvent {
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : input.timestamp ?? new Date().toISOString();
  const eventId =
    input.eventId ??
    `recall-observed:${input.surface}:${input.query ?? "anon"}:${Date.parse(timestamp) || timestamp}`;
  const sessionId = input.sessionId ?? `recall:${input.surface}`;
  const tokensSaved = Math.max(0, input.tokensBaseline - input.tokensCompressed);
  return parseMemoryEvent({
    id: eventId,
    occurred_at: timestamp,
    kind: "memory.recall.observed",
    source: { kind: "memory", name: "memory.recall" },
    actor: { kind: "agent", id: input.runner ?? input.surface },
    scope: { level: "session", id: sessionId },
    subject: { kind: "recall", id: input.query ?? input.surface },
    payload: {
      event_type: "memory.recall.observed",
      event_id: eventId,
      timestamp,
      surface: input.surface,
      ...(input.query ? { query: input.query } : {}),
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      ...(input.runner ? { runner: input.runner } : {}),
      candidate_count: input.candidateCount,
      returned_count: input.returnedCount,
      hit: input.hitCount > 0,
      hit_count: input.hitCount,
      gold_in_pack_proxy: input.goldInPackProxy,
      ...(input.goldProxyRank != null ? { gold_proxy_rank: input.goldProxyRank } : {}),
      tokens_baseline: input.tokensBaseline,
      tokens_compressed: input.tokensCompressed,
      tokens_saved: tokensSaved,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
    provenance: {
      source_kind: "system",
      writer: "memory",
      command: "memory recall-observed",
      evidence: [`event_id:${eventId}`],
    },
  });
}

/**
 * Build a `memory.drift.caught` event (ADR 0025) for the CI drift guard (#224).
 * The guard emits one of these when it fails a PR so the maintainer can see how
 * often the markdown↔graph drift guard actually catches divergence.
 */
export function driftCaughtToMemoryEvent(input: DriftCaughtInput): MemoryEvent {
  const timestamp =
    input.timestamp instanceof Date
      ? input.timestamp.toISOString()
      : input.timestamp ?? new Date().toISOString();
  const scopeId = input.prNumber ?? input.headSha ?? "pr";
  const eventId =
    input.eventId ?? `drift:${scopeId}:${Date.parse(timestamp) || timestamp}`;
  return parseMemoryEvent({
    id: eventId,
    occurred_at: timestamp,
    kind: "memory.drift.caught",
    source: { kind: "ci", name: "red-memory-drift-guard" },
    actor: { kind: "ci", id: "github-actions" },
    scope: { level: "pull-request", id: scopeId },
    subject: { kind: "drift", id: input.changedPaths[0] },
    payload: {
      event_type: "memory.drift.caught",
      event_id: eventId,
      timestamp,
      changed_paths: [...input.changedPaths],
      reason: input.reason,
      ...(input.prNumber ? { pr_number: input.prNumber } : {}),
      ...(input.headSha ? { head_sha: input.headSha } : {}),
      ...(input.baseRef ? { base_ref: input.baseRef } : {}),
    },
    provenance: {
      source_kind: "system",
      writer: "memory",
      command: "memory drift-guard",
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

export async function appendContextPackGenerationEvent(
  store: MemoryStore,
  input: ContextPackGenerationInput,
): Promise<void> {
  await appendMemoryEvent(store, contextPackGenerationToMemoryEvent(input));
}

export async function appendMemoryInjectionEvent(
  store: MemoryStore,
  input: MemoryInjectionInput,
): Promise<void> {
  await appendMemoryEvent(store, memoryInjectionToMemoryEvent(input));
}

/**
 * Best-effort recall-observation append. Telemetry is additive and must never
 * fail the recall it describes (issue #828, mirroring `appendEngineOpEvent`).
 */
export async function appendRecallObservationEvent(
  store: MemoryStore,
  input: RecallObservationInput,
): Promise<void> {
  try {
    await appendMemoryEvent(store, recallObservationToMemoryEvent(input));
  } catch {
    // Swallowed by design — see function docs.
  }
}

export function deriveMemoryInjectionRollups(events: readonly MemoryEvent[]): MemoryInjectionRollup[] {
  const rollups = new Map<string, MemoryInjectionRollup>();
  for (const event of events) {
    if (event.kind !== "memory.injection.delivered") continue;
    const payload = event.payload as MemoryInjectionPayload;
    const touched = new Map<string, { citation_id?: string; node_id?: number }>();
    for (const citationId of payload.delivered_citation_ids) {
      touched.set(`citation:${citationId}`, { citation_id: citationId });
    }
    for (const nodeId of payload.delivered_node_ids) {
      touched.set(`node:${nodeId}`, { node_id: nodeId });
    }
    for (const [id, ids] of touched) {
      const prev = rollups.get(id);
      const surfaces = new Set(prev?.delivery_surfaces ?? []);
      surfaces.add(payload.delivery_surface);
      rollups.set(id, {
        id,
        ...ids,
        delivered_count: (prev?.delivered_count ?? 0) + 1,
        last_injected_at:
          !prev || Date.parse(payload.timestamp) >= Date.parse(prev.last_injected_at)
            ? payload.timestamp
            : prev.last_injected_at,
        delivery_surfaces: [...surfaces].sort(),
      });
    }
  }
  return [...rollups.values()].sort((a, b) => a.id.localeCompare(b.id));
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
