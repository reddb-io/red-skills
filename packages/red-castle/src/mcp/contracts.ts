import { z } from "zod/v3";
import type { CastleMcpTool } from "./tool.js";

/**
 * Version of the declared observability output contracts. Bump the MAJOR when a
 * declared field is removed, renamed, or changes type — consumers compare this
 * string to detect a breaking change. Adding an OPTIONAL field is additive and
 * keeps the version.
 */
export const CASTLE_MCP_CONTRACT_VERSION = "2.0.0";

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

export const heartbeatObservationSchema = z.object({
  /** Seconds since the last heartbeat tick; -1 when never observed. */
  age_s: z.number(),
  stale: z.boolean(),
  stale_after_s: z.number(),
  reason: z.enum(["fresh", "aged-out", "never-observed", "orphaned"]),
});

export type HeartbeatObservationOutput = z.infer<typeof heartbeatObservationSchema>;

/**
 * One owner answers "what version is published" and every surface derives from
 * it (#2809). `source` names where the answer came from, so a disagreement is
 * diagnosable from the report itself; `version: ""` means unresolved, which is a
 * distinct answer from a measured match.
 */
export const publishedVersionObservationSchema = z.object({
  version: z.string(),
  source: z.enum(["registry", "recorded", "installed-plugin", "bundle-cache", "unresolved"]),
  /** Milliseconds since the answer was observed; -1 when never observed. */
  age_ms: z.number(),
  stale_after_ms: z.number(),
  stale: z.boolean(),
  reason: z.enum(["fresh", "aged-out", "installed-only", "cache-only", "never-observed"]),
});

export type PublishedVersionObservationOutput = z.infer<typeof publishedVersionObservationSchema>;

/**
 * What the host holds for this project, since a project contributes a
 * REGISTRATION rather than a process (ADR 0130 Amendment 4, #2909).
 *
 * `held: false` carries the latest lapse detail when the daemon recorded one,
 * and it is a different fact from an unreachable daemon — which is why
 * `daemon_reachable` is stated beside it rather than folded into it: a reader
 * that could not tell them apart would send an operator to `project_start` when
 * the real problem is a host that never answered.
 */
export const projectRegistrationStatusSchema = z.object({
  held: z.boolean(),
  daemon_reachable: z.boolean(),
  project: z.string(),
  socket: z.string(),
  /** The work query this project registered; "" when it holds no registration. */
  selector: z.string(),
  /** How many Workers the project asked the host for; 0 when unregistered. */
  target: z.number(),
  /**
   * What is holding the record up; `unknown` when it is unheld.
   *
   * Three states rather than a boolean, because they send an operator to three
   * places: `renewing` is a live session, `self-renewing` is the daemon holding a
   * registration up on the project's own open work (ADR 0130 Amendment 7), and
   * `running-on` is work nobody is watching, on a deadline it will lapse at.
   */
  renewal: z.enum(["renewing", "self-renewing", "running-on", "unknown"]),
  /** When the registration lapses unless renewed; "" when unheld. */
  renew_by: z.string(),
  renewals: z.number(),
  /** When the latest registration lapse was observed; "" when none is known. */
  lapsed_at: z.string(),
  /** Why registration is absent; "" while a current registration is held. */
  reason: z.string(),
  /**
   * How many times the launch has been restated (ADR 0130 Amendment 5). Separate
   * from `renewals` because most renewals restate nothing: this is the number
   * that moves when a runner directive lands.
   */
  launch_revision: z.number(),
  /** Engine version named by the registration argv; "" when it cannot be read. */
  bundle_version: z.string(),
  /** Newest dev plugin version in the host's plugin cache; "" when absent. */
  plugin_cache_version: z.string(),
  /**
   * What the last queue poll said about THIS project; absent when none has run.
   *
   * Absent is a different answer from a depth of zero — nobody has counted this
   * yet — and it sends an operator to the daemon rather than to the backlog.
   */
  last_poll: z
    .object({
      at: z.string(),
      outcome: z.string(),
      depth: z.number().nullable(),
      request_count: z.number(),
      detail: z.string(),
    })
    .optional(),
  /**
   * The published-version answer WITH its own currency, from the same owner the
   * Worker boot probe consults. Staleness travels inside the payload
   * (ADR 0128 §6) so a cached read cannot be rendered as current (#2809).
   */
  published_version: publishedVersionObservationSchema.optional(),
});

export type ProjectRegistrationStatusOutput = z.infer<typeof projectRegistrationStatusSchema>;

export const projectStatusOutputSchema = z.object({
  registration: projectRegistrationStatusSchema,
  slots: z.object({
    busy: z.number(),
    free: z.number(),
    parked: z.number(),
    total: z.number(),
    /** Capacity above `total`, reserved for human-attached `/go` and scout work. */
    interactive_reservation: z.number(),
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
   * Live workers this project does not own — a Worker the host attributes to
   * another project, or one carrying no project stamp at all, so a stale or
   * foreign worker is never silently counted as ours.
   */
  unattributed_workers: z.array(
    z.object({
      id: z.string(),
      pid: z.number(),
      issue: z.string(),
      activity: z.string(),
      origin: z.string(),
    }),
  ),
  /**
   * What went structurally wrong with the read itself (#3081).
   *
   * A project whose own Workers all land in `unattributed_workers` renders
   * exactly like an idle repository, and the two are opposite states: the first
   * is a broken identity wire, the second is nothing to do. An attribution
   * predicate that matched nothing across a non-empty Worker set says so here
   * rather than letting `live_workers: []` read as calm.
   */
  warnings: z.array(z.string()).optional(),
});

export type ProjectStatusOutput = z.infer<typeof projectStatusOutputSchema>;

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
  // `capped` (#2701): the per-issue wall-clock ceiling fired on an attempt that
  // was still working. Published distinctly so a client never renders a long
  // productive worker as stalled.
  status: z.enum(["alive", "stalled", "capped", "unknown"]),
  laneFresh: z.boolean(),
  laneAgeMs: z.number().optional(),
  crossCheckArmed: z.boolean(),
  liveDescendants: z.boolean().optional(),
  reason: z.string(),
});

/**
 * The daemon's verdict on this worker's PROCESS, and how current that verdict is.
 *
 * The host daemon owns birth and death, so it is the single liveness anchor —
 * never a pid file, which is what deleted the live lane and kept the dead ones
 * (#2679). Two properties are published rather than left to a consumer:
 *
 *  1. `dead` IS ONLY REPRESENTABLE BESIDE A FRESH READ. An unreachable or stale
 *     daemon answers `unknown`, so no payload reports a worker dead beside fresh
 *     evidence that it is alive.
 *  2. STALENESS TRAVELS INSIDE THE PAYLOAD. A renderer honours `stale`; it never
 *     re-derives it from `age_ms` and a threshold of its own.
 */
const daemonLivenessSchema = z.object({
  verdict: z.enum(["alive", "dead", "unknown"]),
  anchor: z.enum(["daemon", "none"]),
  project_label: z.string().nullable(),
  pid: z.number().nullable(),
  staleness: z.object({
    stale: z.boolean(),
    age_ms: z.number().nullable(),
    threshold_ms: z.number().nullable(),
    reason: z.string(),
  }),
});

export type DaemonLivenessOutput = z.infer<typeof daemonLivenessSchema>;

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
  daemon_liveness: daemonLivenessSchema.optional(),
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
      interactiveReservation: z.number(),
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

const queueIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  labels: z.array(z.string()),
});

export const queueStatusOutputSchema = z.object({
  ready_for_agent: z.object({
    eligible: z.array(queueIssueSchema),
    held_for_summon: z.array(queueIssueSchema),
  }),
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
    ready_for_agent_eligible: z.number(),
    ready_for_agent_held: z.number(),
    ready_for_human: z.number(),
  }),
});

export type QueueStatusOutput = z.infer<typeof queueStatusOutputSchema>;

// ---------------------------------------------------------------------------
// declaration + enforcement
// ---------------------------------------------------------------------------

export const projectStatusContract = contract(projectStatusOutputSchema);
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
