import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

/**
 * Version of the declared observability output contracts. Bump the MAJOR when a
 * declared field is removed, renamed, or changes type — consumers compare this
 * string to detect a breaking change. Adding an OPTIONAL field is additive and
 * keeps the version.
 */
export const CASTLE_MCP_CONTRACT_VERSION = "1.0.0";

/**
 * One tool's declared output shape plus the version that shape belongs to.
 *
 * `projection` covers the tools that let a caller narrow their own payload: it
 * names the input field that requests the narrowing and the relaxed schema to
 * validate against when it is used. Projection relaxes PRESENCE, never TYPE —
 * a field the caller did ask for is still checked, so narrowing stays a
 * supported call rather than a contract escape hatch.
 */
export interface CastleMcpOutputContract {
  version: string;
  schema: z.ZodTypeAny;
  projection?: { input: string; schema: z.ZodTypeAny };
}

function contract(
  schema: z.ZodTypeAny,
  projection?: CastleMcpOutputContract["projection"],
): CastleMcpOutputContract {
  return { version: CASTLE_MCP_CONTRACT_VERSION, schema, projection };
}

// ---------------------------------------------------------------------------
// fleet_status
// ---------------------------------------------------------------------------

/** Mirrors the watchdog's `SupervisorHealth` verdict. */
const supervisorHealthSchema = z.enum(["absent", "healthy", "quiescent"]);

export const fleetStatusOutputSchema = z.object({
  fleet: z.string(),
  supervisor: z.object({
    pid: z.number(),
    alive: z.boolean(),
    health: supervisorHealthSchema,
    runner: z.string(),
    target: z.number(),
    bundle_version: z.string(),
    bundle_latest: z.string(),
    /** 1 when the running supervisor's bundle differs from the newest cached one. */
    version_skew: z.number(),
    /** Seconds since the supervisor's last heartbeat; -1 when never observed. */
    heartbeat_age_s: z.number(),
  }),
  slots: z.object({
    busy: z.number(),
    free: z.number(),
    parked: z.number(),
    total: z.number(),
  }),
  churn: z.object({
    deaths: z.number(),
    respawns: z.number(),
    window_s: z.number(),
  }),
  live_workers: z.array(
    z.object({
      id: z.string(),
      pid: z.number(),
      issue: z.string(),
      activity: z.string(),
      origin: z.string(),
    }),
  ),
  /**
   * Live workers this fleet does not own — a worker whose recorded fleet name
   * differs, so a stale or foreign process is never silently counted as ours.
   * `fleet` is null when the worker recorded no fleet name at all.
   */
  unattributed_workers: z.array(
    z.object({
      id: z.string(),
      pid: z.number(),
      issue: z.string(),
      activity: z.string(),
      origin: z.string(),
      fleet: z.string().nullable(),
    }),
  ),
});

export type FleetStatusOutput = z.infer<typeof fleetStatusOutputSchema>;

// ---------------------------------------------------------------------------
// worker_vitals
// ---------------------------------------------------------------------------

/** The canonical WorkerVitals signal set (ADR 0065), one name per signal. */
const workerVitalsCurrentSchema = z.object({
  number: z.union([z.number(), z.string()]),
  runner: z.string(),
  retries: z.number(),
  phase: z.string(),
  iteration: z.union([z.number(), z.string()]),
  activity: z.string(),
  loc_added: z.number(),
  loc_removed: z.number(),
  last_commit_at: z.string(),
  tools_called_count: z.number(),
  text_chunk_count: z.number(),
  reasoning_events: z.number(),
  reasoning_tokens: z.number(),
  last_event_at: z.string(),
  waiting_count: z.number(),
  input_tokens: z.number(),
  output_tokens: z.number(),
  cost_usd: z.number(),
});

/** The red-castle evaluator verdict (ADR 0083 §3) as published to clients. */
const livenessVerdictSchema = z.object({
  status: z.enum(["alive", "stalled", "unknown"]),
  laneFresh: z.boolean(),
  laneAgeMs: z.number().optional(),
  crossCheckArmed: z.boolean(),
  liveDescendants: z.boolean().optional(),
  reason: z.string(),
});

const workerVitalsRecordSchema = z.object({
  worker: z.object({
    id: z.string(),
    pid: z.number(),
    runner: z.string(),
    origin: z.string(),
    started_at: z.string(),
    done: z.number(),
    total: z.number(),
    blocked: z.number(),
    failed: z.number(),
    current: workerVitalsCurrentSchema,
  }),
  live: z.boolean(),
  active: z.boolean(),
  renderable_live: z.boolean(),
  liveness: z.enum(["active", "quiet-but-live", "dead"]),
  liveness_verdict: livenessVerdictSchema,
});

export const workerVitalsOutputSchema = z.array(workerVitalsRecordSchema);

/**
 * The shape a `fields`-projected `worker_vitals` call returns: the same records
 * with only the requested top-level keys kept. Every key that IS present must
 * still match its declared type.
 */
export const workerVitalsProjectedOutputSchema = z.array(
  workerVitalsRecordSchema.partial(),
);

export type WorkerVitalsOutput = z.infer<typeof workerVitalsOutputSchema>;
export type WorkerVitalsProjectedOutput = z.infer<
  typeof workerVitalsProjectedOutputSchema
>;

// ---------------------------------------------------------------------------
// monitor
// ---------------------------------------------------------------------------

/** The subset of each rendered worker the monitor contract guarantees. Renderers
 * read more fields off the same records; only these are contractual. */
const monitorWorkerSchema = z.object({
  state: z.object({
    worker_id: z.string(),
    pid: z.number(),
    runner: z.string(),
    started_at: z.string(),
    total: z.number(),
    done: z.number(),
    blocked: z.number(),
    failed: z.number(),
    current: z.object({
      number: z.union([z.number(), z.string()]),
      title: z.string(),
      activity: z.string(),
      started_at: z.string(),
    }),
  }),
  live: z.boolean(),
});

export const monitorOutputSchema = z.object({
  workers: z.array(monitorWorkerSchema),
  events: z.array(z.object({ event: z.string(), epoch: z.number() })),
  fleet: z
    .object({
      ts: z.string(),
      epoch: z.number(),
      runner: z.string(),
      readyForAgent: z.number(),
      slotsBusy: z.number(),
      slotsFree: z.number(),
      slotsTotal: z.number(),
      slotsParked: z.number(),
      spawnsThisTick: z.number(),
    })
    .nullable(),
  /** GitHub queue counts read passively from the statusline TTL cache; absent
   * when no statusline run has ever written it. */
  remoteQueue: z.number().optional(),
  remoteHuman: z.number().optional(),
  remoteCacheAgeS: z.number().optional(),
});

export type MonitorOutput = z.infer<typeof monitorOutputSchema>;

// ---------------------------------------------------------------------------
// queue_status
// ---------------------------------------------------------------------------

export const queueStatusOutputSchema = z.object({
  ready_for_agent: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      labels: z.array(z.string()),
    }),
  ),
  ready_for_human: z.array(
    z.object({
      number: z.number(),
      title: z.string(),
      labels: z.array(z.string()),
      body: z.string().optional(),
      createdAt: z.string().nullable().optional(),
    }),
  ),
  counts: z.object({
    ready_for_agent: z.number(),
    ready_for_human: z.number(),
  }),
});

export type QueueStatusOutput = z.infer<typeof queueStatusOutputSchema>;

// ---------------------------------------------------------------------------
// declaration + enforcement
// ---------------------------------------------------------------------------

export const fleetStatusContract = contract(fleetStatusOutputSchema);
export const workerVitalsContract = contract(workerVitalsOutputSchema, {
  input: "fields",
  schema: workerVitalsProjectedOutputSchema,
});
export const monitorContract = contract(monitorOutputSchema);
export const queueStatusContract = contract(queueStatusOutputSchema);

/**
 * The schema this one call must satisfy — the relaxed projection schema when the
 * caller asked for a non-empty narrowing, the full declared shape otherwise.
 */
function schemaFor(
  declared: CastleMcpOutputContract,
  input: Record<string, unknown>,
): z.ZodTypeAny {
  const { projection } = declared;
  if (!projection) return declared.schema;
  const requested = input[projection.input];
  const narrowed = Array.isArray(requested) && requested.length > 0;
  return narrowed ? projection.schema : declared.schema;
}

/**
 * Wrap every tool that declares an `outputContract` so its payload is validated
 * before it reaches a client. Shape drift — a dropped field, a retyped field —
 * becomes a thrown, named error at the adapter seam instead of a silently
 * malformed answer downstream.
 *
 * Validation NEVER rewrites the payload: unknown keys survive untouched, so the
 * wire surface stays byte-identical for existing consumers. This is why the
 * declared schemas are enforcement, not serialization.
 *
 * A call that requests the contract's `projection` input is checked against the
 * relaxed schema instead, so caller-driven narrowing stays a supported call.
 */
export function applyOutputContracts(tools: CastleMcpTool[]): CastleMcpTool[] {
  return tools.map((tool) => {
    const declared = tool.outputContract;
    if (!declared) return tool;
    const realInvoke = tool.invoke.bind(tool);
    return {
      ...tool,
      invoke: async (input) => {
        const result = await realInvoke(input);
        const parsed = schemaFor(declared, input).safeParse(result);
        if (!parsed.success) {
          throw new Error(
            `${tool.name} output violates contract ${declared.version}: ${parsed.error.issues
              .map(
                (issue) =>
                  `${issue.path.join(".") || "<root>"}: ${issue.message}`,
              )
              .join("; ")}`,
          );
        }
        return result;
      },
    };
  });
}
