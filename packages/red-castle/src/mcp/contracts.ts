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

/**
 * Staleness travels INSIDE the payload (ADR 0128 §6), so a stale read can never
 * be presented as current. `stale` is the anchor's verdict, not a threshold the
 * renderer re-derives: `orphaned` means a heartbeat with no live writer to vouch
 * for it, which is stale at any age.
 */
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

export const projectStatusOutputSchema = z.object({
  supervisor: z.object({
    pid: z.number(),
    alive: z.boolean(),
    health: supervisorHealthSchema,
    runner: z.string(),
    target: z.number(),
    bundle_version: z.string(),
    bundle_latest: z.string(),
    /**
     * 1 when the supervisor's bundle version was never measured. Distinct from
     * `version_skew: 0`, which is a measured match: an absent version is
     * inconclusive, and reporting it as no-skew is what let a missing field
     * masquerade as a healthy one (#2752).
     */
    version_unknown: z.number(),
    /**
     * 1 when the published version could not be resolved at all. A skew verdict
     * needs BOTH sides measured, so an unresolved published version reports
     * unknown instead of a confident `version_skew: 0` derived from a
     * substituted local value (#2809).
     */
    published_unknown: z.number().optional(),
    /** 1 when the running supervisor's bundle differs from the published one. */
    version_skew: z.number(),
    /**
     * The published-version answer WITH its own currency, from the same owner
     * the Worker boot probe consults. Staleness travels inside the payload
     * (ADR 0128 §6) so a cached read cannot be rendered as current (#2809).
     */
    published_version: publishedVersionObservationSchema.optional(),
    /** Seconds since the supervisor's last heartbeat; -1 when never observed. */
    heartbeat_age_s: z.number(),
    /**
     * Which anchor resolved the supervisor's identity: the `afk-supervisor.pid`
     * lock, the `state.toon` heartbeat snapshot, or `none` when no live
     * supervisor was found. Names the source so a disagreement between the two
     * anchors is diagnosable from the report itself (#2698).
     */
    identity_anchor: z.enum(["pid-file", "fleet-state", "none"]),
    /**
     * The same anchor read that decided `alive`, published so the consumer sees
     * the staleness rather than re-deriving it. `alive: false` always carries
     * `stale: true`, which is what makes "absent beside a fresh heartbeat"
     * unrepresentable rather than merely unlikely (#2704).
     */
    heartbeat: heartbeatObservationSchema,
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
   * Live workers this project's supervisor does not own — a process whose pid
   * is absent from the supervisor's slot map, so a stale or foreign worker is
   * never silently counted as ours.
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
      spawnsThisTick: z.number(),
    })
    .nullable(),
  /**
   * The supervisor as the single anchor resolved it (#2704). The monitor no
   * longer infers a supervisor from the snapshot it renders; it publishes the
   * anchor's verdict and its staleness verbatim.
   */
  supervisor: z
    .object({
      pid: z.number(),
      alive: z.boolean(),
      identity_anchor: z.enum(["pid-file", "fleet-state", "none"]),
      heartbeat: heartbeatObservationSchema,
    })
    .optional(),
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
