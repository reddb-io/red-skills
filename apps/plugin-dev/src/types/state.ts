import { z } from "zod";

export const AfkFilterSchema = z.object({
  kind: z.string().default(""),
  value: z.string().default(""),
});

export const AfkCurrentSchema = z.object({
  /** Castle worker kind for this dispatch (`afk`, `go`, or `scout`). Kept under
   * `current` so it does not collide with castle's top-level state entity kind
   * (`worker` / `supervisor`). */
  kind: z.string().default(""),
  number: z.union([z.number(), z.string()]).optional().default(""),
  title: z.string().default(""),
  slug: z.string().default(""),
  worktree: z.string().default(""),
  handoff: z.string().default(""),
  started_at: z.string().default(""),
  activity: z.string().default(""),
  /** Macro-lifecycle phase of the attempt (issue #811) — the calm signal the
   * task-mirror TITLE surfaces (`setup → coding → validating → merging → done`,
   * plus the terminal `blocked`), distinct from `activity` (the fine explore/
   * impl/tests/commit detail that feeds the task DESCRIPTION). Kept a plain string so
   * an out-of-vocab value round-trips through `updateState` instead of being
   * stripped; the ordered vocabulary is owned by `AFK_PHASE_ORDER` in
   * `core/mirror.ts` (it drives the `n/5` position). Defaults to "". */
  phase: z.string().default(""),
  heartbeat_glyph: z.union([z.string(), z.number(), z.null()]).optional().default(""),
  heartbeat_pid: z.union([z.string(), z.number(), z.null()]).optional().default(""),
  runner: z.string().default(""),
  /** Model identifier resolved for this attempt (e.g. `claude-opus-4-8`). Stamped
   * once at attempt start. Used by the statusline to show which model is running. */
  model: z.string().default(""),
  /** Classifier-selected AFK tier that resolved `model`/`effort`. Kept beside
   * the concrete runner settings so monitor readers can explain the route. */
  model_tier: z.string().default(""),
  /** Effort level resolved for this attempt (e.g. `high`, `max`). Paired with
   * `model` on the statusline runner label. */
  effort: z.string().default(""),
  retries: z.number().default(0),
  last_stream_line: z.string().default(""),
  run_mode: z.string().default(""),
  /** ISO timestamp of the last observed COMMIT on the worker branch (or run
   * start). Written on each worker-vitals sample. Purely observational since
   * ADR 0103 removed the commit-anchored guard that used to abort on it — stall
   * detection reads the castle liveness lane, never this field.
   * Renamed from `last_progress_at` (which mislabeled "commit" as "progress");
   * read-shimmed from the old key for one release. See ADR 0065. */
  last_commit_at: z.string().default(""),
  /** ISO timestamp of the last observed LOC-volume change. Unlike
   * `last_commit_at`, this advances while an uncommitted edit grows or shrinks,
   * so display surfaces can expose a real-progress clock that does not reset on
   * every read/test/tool transition. */
  last_loc_progress_at: z.string().default(""),
  /** ISO timestamp of the last observed STREAM event (any agent text/tool/
   * reasoning chunk), stamped in `recordAgentEvent`. The honest liveness clock:
   * an exploring worker advances this every few seconds even when it has not
   * committed, so `silent_for_s` (now − last_event_at) is the true stuck signal,
   * distinct from `last_commit_at`. See ADR 0065. */
  last_event_at: z.string().default(""),
  /** Current sandcastle agentic-iteration number (1..maxIterations), advanced
   * each time the inner agent's re-invocation count ticks. Lets the monitor show
   * "iter N/max" and surfaces a run burning through iterations re-validating. */
  iteration: z.union([z.number(), z.string()]).optional().default(""),
  /** Resolved base branch (lock > pin > main) for this attempt. Persisted on
   * first heartbeat so the monitor/statusline fallback diffstat uses the correct
   * ref instead of hardcoding origin/main. */
  base: z.string().default(""),
  /** Concrete resolved base ref/tip evidence for this attempt (#1380). The
   * attempt-start path writes these before the inner agent runs so monitor and
   * envelopes can distinguish a freshly fetched `origin/<base>` worker from an
   * offline local-base fallback or a typed stale-base park. */
  base_ref: z.string().default(""),
  base_sha: z.string().default(""),
  base_source: z.string().default(""),
  base_remote_reachable: z.boolean().default(false),
  base_local_sha: z.string().default(""),
  base_local_ahead: z.number().default(0),
  base_local_behind: z.number().default(0),
  /** Per-attempt stream-activity counters (the WorkerVitals activity + progress
   * groups, ADR 0065), mirrored from the proof-of-life heartbeat's `statePatch`
   * (core/heartbeat.ts → buildProgressHeartbeat) each ~60s poll. These MUST be
   * declared here: `updateState` round-trips the whole state through this schema
   * before writing, so an undeclared key is silently stripped on BOTH write and
   * read. The monitor/statusline read them straight off `current` to show
   * liveness without opening the firehose. Canonical names — `reasoning_events`
   * (was `thinking_called_count`) and `loc_added`/`loc_removed` (was `diff_*`);
   * the legacy keys are read-shimmed in `parseState` for one release. */
  tools_called_count: z.number().default(0),
  text_chunk_count: z.number().default(0),
  reasoning_events: z.number().default(0),
  reasoning_tokens: z.number().default(0),
  waiting_count: z.number().default(0),
  loc_added: z.number().default(0),
  loc_removed: z.number().default(0),
  /** Last observed non-zero diff for this attempt (monotonically updated by the
   * heartbeat when `loc_added > loc_peak_added` or `loc_removed > loc_peak_removed`).
   * The statusline reads this as a sticky fallback when the current diff drops to 0
   * (e.g. between commits and the next heartbeat) — prevents the `loc=` token from
   * disappearing mid-attempt, which looks alarming even when the work is intact. */
  loc_peak_added: z.number().default(0),
  loc_peak_removed: z.number().default(0),
  /** Cost group (ADR 0065) — cumulative per-worker token spend, summed from the
   * runner's `usage` stream events (codex/opencode live; claude at iteration
   * boundary, a follow-up). `cost_usd` is populated only when the runner reports
   * cost directly. */
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cost_usd: z.number().default(0),
  /** Input-side tokens the LAST turn carried — the context window's occupancy
   * (#3097), distinct from the cumulative `input_tokens` beside it. The sum of
   * the turn's `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`,
   * which is what "context window: 103k" means everywhere else in the engine.
   * Last-observed rather than cumulative on purpose: a context window is a level,
   * not a total, and a Worker's whole spend says nothing about how close its next
   * turn is to the ceiling. 0 means no runner has reported one. */
  context_tokens: z.number().default(0),
  /** Output-shaping measurement arm (#1638). `steered` attempts receive only
   * phrasing constraints; `holdout` attempts receive no steering. Paired with
   * the existing `output_tokens` heartbeat counter for the report surface. */
  output_shaping_variant: z.string().default(""),
  output_shaping_enabled: z.boolean().default(false),
  /** Re-seed rounds spent by this Worker, retained as an aggregatable fact for
   * landed-Ticket experiments. Zero is an observed result, never absence. */
  reseed: z.object({
    version: z.literal(1).default(1),
    rounds: z.number().int().nonnegative().default(0),
    by_cause: z.object({
      gate: z.number().int().nonnegative().default(0),
      tier: z.number().int().nonnegative().default(0),
      review: z.number().int().nonnegative().default(0),
    }).default({ gate: 0, tier: 0, review: 0 }),
  }).default({ version: 1, rounds: 0, by_cause: { gate: 0, tier: 0, review: 0 } }),
  /** What the ORCHESTRATOR is blocked on, when it is blocked on something that
   * spawns no child and writes nothing — today the two host-wide gate locks
   * (#2985). Empty means "not blocked". Without it a worker waiting up to an
   * hour on `validation-gate.lock` was indistinguishable from a healthy one:
   * `live=true`, no child, no write, and nothing anywhere naming the wait.
   * `blocked_for_s` is the wait's own age, distinct from `silent_for_s`. */
  blocked_on: z.string().default(""),
  blocked_detail: z.string().default(""),
  blocked_for_s: z.union([z.number(), z.string()]).optional().default(""),
  /** A child-process wait declared by the Worker that spawned it. Unlike the
   * agent-stream heartbeat, this clock advances honestly while the orchestrator
   * is blocked in `await child`: subject says what, pid says which process, and
   * started_at is the wait's own age anchor. Deadline + escalation reuse the
   * engine's declared-wait vocabulary so the wait is never merely descriptive. */
  wait_kind: z.string().default(""),
  wait_subject: z.string().default(""),
  wait_pid: z.number().default(0),
  wait_started_at: z.string().default(""),
  wait_deadline: z.string().default(""),
  wait_escalation: z.string().default(""),
  /** Implementer projection measurements consumed by the throughput dashboard. */
  implementer_runner_startup_before_ms: z.number().default(0),
  implementer_runner_startup_after_ms: z.number().default(0),
  implementer_skill_manifest_before_bytes: z.number().default(0),
  implementer_skill_manifest_after_bytes: z.number().default(0),
});

export const AfkStateSchema = z.object({
  version: z.number().default(1),
  worker_id: z.string().default(""),
  pid: z.number().default(0),
  /** Stable process identity paired with `pid` when the OS exposes one. Linux
   * writes `/proc/<pid>/stat` field 22 here; empty means legacy/unavailable and
   * readers fall back to pid-only liveness. */
  pid_start_time: z.string().default(""),
  log: z.string().default(""),
  started_at: z.string().default(""),
  /** Spawn-time provenance: the entry point that launched this worker
   * (`"afk"` | `"go"` | `"urgent"` | `""`). Stamped once at `initStateSync`
   * via the `--origin` flag and never mutated. Empty means unknown/pre-field
   * (round-trip safe — out-of-vocab values survive through `updateState`).
   * The single source of truth both statusline and monitor read for per-source
   * worker counts; no independent derivation allowed. */
  origin: z.string().default(""),
  runner: z.string().default(""),
  /** Runner-owned persisted session artifact for this Worker. Empty is a legal,
   * explicit state: some runners or failure paths produce no file-backed
   * session. This is a pointer only; the Worker never copies or moves it. */
  session_artifact: z.string().default(""),
  filter: AfkFilterSchema.default({}),
  total: z.number().default(0),
  done: z.number().default(0),
  failed: z.number().default(0),
  blocked: z.number().default(0),
  completed: z.array(z.number()).default([]),
  queue: z.array(z.number()).default([]),
  current: AfkCurrentSchema.default({}),
  durations_seconds: z.array(z.number()).default([]),
  envelope: z.object({ posted: z.boolean().default(false) }).default({ posted: false }),
});

export type AfkState = z.infer<typeof AfkStateSchema>;

/** The full `current` sub-state of a running attempt (issue identity + worktree
 * bookkeeping + the WorkerVitals signals). */
export type AfkCurrent = z.infer<typeof AfkCurrentSchema>;

/**
 * The canonical worker-vitals contract (ADR 0065) — the observable signals a
 * running AFK worker emits, one name per signal, grouped by the question each
 * group answers. This is the single shape consumers (statusline, monitor,
 * dashboard) read; `AfkCurrent` (the persisted `current.*`) is a superset of it,
 * enforced by the `_AfkCurrentSatisfiesWorkerVitals` assertion below — so adding
 * or renaming a vital is one declaration here + the schema, and a drift between
 * the two fails to compile. The red-castle stream-event → field map is pinned by
 * the contract test in `tests/worker-vitals.contract.test.ts`.
 */
export interface WorkerVitals {
  // identity
  number: number | string;
  runner: string;
  retries: number;
  model: string;
  effort: string;
  // lifecycle
  phase: string;
  iteration: number | string;
  activity: string;
  // progress
  loc_added: number;
  loc_removed: number;
  last_commit_at: string;
  // activity
  tools_called_count: number;
  text_chunk_count: number;
  reasoning_events: number;
  reasoning_tokens: number;
  last_event_at: string;
  // liveness
  waiting_count: number;
  // cost
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

/** Compile-time guarantee that the persisted `current.*` satisfies the canonical
 * WorkerVitals contract. If a vital is renamed on the schema without updating
 * {@link WorkerVitals} (or vice-versa), this assignment fails to compile. */
const _AfkCurrentSatisfiesWorkerVitals: WorkerVitals = undefined as unknown as AfkCurrent;
void _AfkCurrentSatisfiesWorkerVitals;
