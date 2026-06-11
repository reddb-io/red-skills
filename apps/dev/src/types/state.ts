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
  diff_added: z.number().default(0),
  diff_removed: z.number().default(0),
  last_stream_line: z.string().default(""),
  run_mode: z.string().default(""),
  /** ISO timestamp of the last observed progress — the last new commit on the
   * worker branch, or attempt start. Written each attempt-guard poll (PR-B) so an
   * external monitor reading afk.state.json sees liveness/progress, not just a
   * stale stream line. Empty until the guard arms (no-sandbox runs). */
  last_progress_at: z.string().default(""),
  /** Current sandcastle agentic-iteration number (1..maxIterations), advanced
   * each time the inner agent's re-invocation count ticks. Lets the monitor show
   * "iter N/max" and surfaces a run burning through iterations re-validating. */
  iteration: z.union([z.number(), z.string()]).optional().default(""),
  /** Resolved base branch (lock > pin > main) for this attempt. Persisted on
   * first heartbeat so the monitor/statusline fallback diffstat uses the correct
   * ref instead of hardcoding origin/main. */
  base: z.string().default(""),
  /** Per-attempt stream-activity counters, mirrored from the proof-of-life
   * heartbeat's `statePatch` (core/heartbeat.ts → buildProgressHeartbeat) each
   * ~60s poll. These MUST be declared here: `updateState` round-trips the whole
   * state through this schema before writing, so an undeclared key is silently
   * stripped on BOTH write and read — the counters would never survive in
   * afk.state.json. The monitor/statusline read them straight off `current` to
   * show liveness (is the agent actually streaming) without opening the firehose.
   * `loc_added`/`loc_removed` are user-facing aliases of `diff_added`/`diff_removed`. */
  tools_called_count: z.number().default(0),
  text_chunk_count: z.number().default(0),
  thinking_called_count: z.number().default(0),
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
