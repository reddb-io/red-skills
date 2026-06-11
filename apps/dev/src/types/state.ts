import { z } from "zod";

export const AfkFilterSchema = z.object({
  kind: z.string().default(""),
  value: z.string().default(""),
});

export const AfkCurrentSchema = z.object({
  number: z.union([z.number(), z.string()]).optional().default(""),
  title: z.string().default(""),
  slug: z.string().default(""),
  worktree: z.string().default(""),
  handoff: z.string().default(""),
  started_at: z.string().default(""),
  stage: z.string().default(""),
  heartbeat_glyph: z.union([z.string(), z.number(), z.null()]).optional().default(""),
  heartbeat_pid: z.union([z.string(), z.number(), z.null()]).optional().default(""),
  runner: z.string().default(""),
  retries: z.number().default(0),
  last_stream_line: z.string().default(""),
  run_mode: z.string().default(""),
  /** ISO timestamp of the last observed COMMIT on the worker branch (or attempt
   * start). Written each attempt-guard poll. The guard's ABORT logic is anchored
   * on this (commit-anchored stall detection, ADR 0044) — NOT on stream activity,
   * so a worker streaming forever without committing is still stalled work.
   * Renamed from `last_progress_at` (which mislabeled "commit" as "progress");
   * read-shimmed from the old key for one release. See ADR 0065. */
  last_commit_at: z.string().default(""),
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
});

export const AfkStateSchema = z.object({
  version: z.number().default(1),
  worker_id: z.string().default(""),
  pid: z.number().default(0),
  log: z.string().default(""),
  started_at: z.string().default(""),
  runner: z.string().default(""),
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
