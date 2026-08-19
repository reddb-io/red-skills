import { buildRecord, type JsonlLogRecord } from "./jsonl-log.js";

// The Heartbeat Module: owns the periodic orchestrator liveness line (issue
// #194) and its firehose mirror (issue #250). Boundary markers alone leave a
// void in afk.log when the inner-agent stdout stream buffers inside the runner
// pipeline; a side-channel loop guarantees one liveness line per
// RED_AFK_HEARTBEAT_S regardless of inner-agent state.
//
// Everything here is PURE line-formatting with injectable IO/clock. The
// vitals-line formatter, the boundary markers, and the firehose record shape
// are byte-for-byte parity with `scripts/lib/heartbeat.sh`. The periodic loop,
// the `ps` read, the state re-read and the clock are all injected so the
// formatting and the per-tick decision are unit-testable without sleeping or
// spawning.

/** Default seconds between periodic heartbeat ticks, mirroring bash. */
export const DEFAULT_HEARTBEAT_S = 60;

/** Process vitals read for a tick: integer cpu percent and rss in MB. */
export interface HeartbeatVitals {
  /** Integer %cpu (bash `awk '{printf "%d", v+0}'`). */
  cpu: number;
  /** Integer rss in MB (bash `(rss_kb+0)/1024` truncated to int). */
  rss: number;
}

/** Per-tick state re-read from afk.state.toon. */
export interface HeartbeatState {
  activity: string;
  lastStreamLine: string;
}

/**
 * Format elapsed seconds as `HH:MM:SS`, mirroring bash
 * `heartbeat_format_elapsed` (`printf '%02d:%02d:%02d'`). Non-integer or
 * negative input is clamped to 0, exactly like the bash regex guard.
 */
export function formatElapsed(secs: number): string {
  let s = secs;
  if (!Number.isInteger(s) || s < 0) s = 0;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Escape a stream line for embedding in the `last_stream_line="..."` field,
 * mirroring the bash substitutions: embedded double-quotes are backslash-
 * escaped and newlines collapse to a single space.
 */
export function escapeStreamLine(stream: string): string {
  return stream.replace(/"/g, '\\"').replace(/\n/g, " ");
}

export interface VitalsLineInput {
  activity: string;
  elapsedSeconds: number;
  lastStreamLine: string;
  cpu: number;
  rss: number;
}

/**
 * The periodic vitals line appended to afk.log.
 * Returned without the trailing newline; the IO layer adds it.
 */
export function formatVitalsLine(input: VitalsLineInput): string {
  const activity = input.activity === "" ? "?" : input.activity;
  const elapsedFmt = formatElapsed(input.elapsedSeconds);
  const stream = escapeStreamLine(input.lastStreamLine);
  return `[heartbeat] activity:${activity} t+${elapsedFmt} last_stream_line="${stream}" cpu=${input.cpu}% rss=${input.rss}M`;
}

/**
 * The `[heartbeat] iteration started for #N at <ts>` boundary marker, matching
 * bash `heartbeat_start`'s `printf` (the timestamp — `date -Is` in bash — is
 * passed in, never read at module scope).
 */
export function formatStartedMarker(issue: number | string, ts: string): string {
  return `[heartbeat] iteration started for #${issue} at ${ts}`;
}

/**
 * The `[heartbeat] iteration stopped at <ts>` boundary marker, matching bash
 * `heartbeat_stop`'s `printf`.
 */
export function formatStoppedMarker(ts: string): string {
  return `[heartbeat] iteration stopped at ${ts}`;
}

/**
 * Per-agentic-iteration boundary marker — the sandcastle Orchestrator's
 * re-invocation count (1..maxIterations), NOT the attempt boundary above. Emitted
 * to afk.log + the firehose when the iteration advances, so a run burning through
 * iterations (e.g. an agent re-running the full test suite each turn instead of
 * emitting DONE) is visible. `max` is the resolved ceiling, shown as `N/max` when
 * known.
 */
export function formatIterationMarker(n: number, phase: "started" | "ended", max?: number): string {
  const of = max !== undefined && max > 0 ? `/${max}` : "";
  return `[afk] agent iteration ${n}${of} ${phase}`;
}

export interface FirehoseIdentity {
  worker?: string;
  issue?: number | string;
  attempt?: number | string;
}

/** Format a line-diff volume as `+A -R`, clamping negatives to 0. */
export function formatDiffVolume(added: number, removed: number): string {
  const a = added > 0 ? added : 0;
  const r = removed > 0 ? removed : 0;
  return `+${a} -${r}`;
}

export interface ProgressHeartbeatInput {
  /** Seconds since the last observed commit (or spawn). */
  secsSinceProgress: number;
  /** ISO timestamp of the last observed progress. */
  lastProgressAt: string;
  /** Worker-branch HEAD this tick ("" when unresolved). */
  head: string;
  /** Added lines vs the merge-base with origin/main (committed + uncommitted). */
  added: number;
  /** Removed lines vs the same base. */
  removed: number;
  /**
   * Optional per-attempt stream-activity counters (the activity-meter snapshot).
   * Omitted on callers/tests that don't observe the stream — when absent the
   * heartbeat is byte-for-byte the pre-metrics record. When present each count
   * rides the firehose `extra` (string-valued) and is mirrored into
   * `current.*_count` so the monitor/statusline can read liveness at a glance.
   */
  activity?: {
    /** Cumulative `toolCall` events this attempt. */
    toolsCalled: number;
    /** Cumulative `text` events this attempt. */
    textChunks: number;
    /** Cumulative `reasoning` events this attempt (all three CLIs). */
    reasoningCount: number;
    /** Cumulative reasoning tokens (codex/opencode; 0 for claude). */
    reasoningTokens: number;
    /** Cumulative heartbeat windows with no new stream event (waiting/blocked). */
    waiting: number;
    /** New stream events in the window this tick closes (0 → a waiting window). */
    eventsThisWindow: number;
    /** Cost group (ADR 0065): cumulative token spend / USD from `usage` events. */
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** Input-side tokens the LAST turn carried — the context window's occupancy
     * (#3097). A level, not a total, so the beat re-stamps it rather than
     * accumulating it. */
    contextTokens: number;
  };
}

export interface ProgressHeartbeat {
  /** Human line for both the firehose `msg` and the `[heartbeat] …` afk.log line. */
  msg: string;
  /** Firehose record `extra` map (all string-valued, like the bash builder). */
  extra: Record<string, string>;
  /** Dotted state-file patch persisting progress + the live diff volume so the
   * monitor's `+A -R` reflects evolution between its 10-min ticks (#448). */
  statePatch: Record<string, string | number>;
}

/**
 * Build the externalized proof-of-life heartbeat the attempt-progress guard
 * emits each ~60s poll (ADR 0045). Unlike the bare liveness record it carries
 * the **line-diff volume** (`+A -R`) so each tick shows how the attempt is
 * evolving, and persists that volume into `current.diff_{added,removed}` — the
 * fields the monitor/statusline prefer over a live `git diff` — so the
 * dashboard's diff stays fresh between its sparse ticks (#448). Pure: the diff
 * counts and timestamps are computed/read by the caller and passed in.
 */
export function buildProgressHeartbeat(input: ProgressHeartbeatInput): ProgressHeartbeat {
  const diff = formatDiffVolume(input.added, input.removed);
  const headShort = input.head ? ` @ ${input.head.slice(0, 8)}` : "";
  const locAdded = input.added > 0 ? input.added : 0;
  const locRemoved = input.removed > 0 ? input.removed : 0;
  const a = input.activity;
  // Append a compact activity tail to the human line so a `tail -f afk.log`
  // shows liveness without opening the firehose. Only when observed.
  const reasonFrag = a
    ? ` think:${a.reasoningCount}${a.reasoningTokens > 0 ? `/${a.reasoningTokens}tok` : ""}`
    : "";
  // Cost tail: shown only when the runner streamed token usage (codex/opencode).
  const costFrag =
    a && (a.inputTokens > 0 || a.outputTokens > 0)
      ? ` tok:${a.inputTokens}/${a.outputTokens}${a.costUsd > 0 ? ` $${a.costUsd.toFixed(2)}` : ""}`
      : "";
  const activityTail = a
    ? ` · tools:${a.toolsCalled} text:${a.textChunks}${reasonFrag} wait:${a.waiting}${costFrag}${a.eventsThisWindow === 0 ? " (idle window)" : ""}`
    : "";
  const msg = `progress: ${input.secsSinceProgress}s since last commit${headShort} · ${diff}${activityTail}`;
  return {
    msg,
    extra: {
      secs_since_progress: String(input.secsSinceProgress),
      // Canonical WorkerVitals names (ADR 0065). The legacy keys below are kept
      // ONLY in the firehose `extra` (append-only history read by post-mortem
      // tooling) for one release; the live state (`statePatch`) is canonical-only.
      last_commit_at: input.lastProgressAt,
      head: input.head,
      loc_added: String(locAdded),
      loc_removed: String(locRemoved),
      diff: diff,
      // Deprecated legacy aliases — remove one release after S1.
      last_progress_at: input.lastProgressAt,
      diff_added: String(locAdded),
      diff_removed: String(locRemoved),
      ...(a
        ? {
            tools_called_count: String(a.toolsCalled),
            text_chunk_count: String(a.textChunks),
            reasoning_events: String(a.reasoningCount),
            reasoning_tokens: String(a.reasoningTokens),
            waiting_count: String(a.waiting),
            events_this_window: String(a.eventsThisWindow),
            input_tokens: String(a.inputTokens),
            output_tokens: String(a.outputTokens),
            cost_usd: String(a.costUsd),
            context_tokens: String(a.contextTokens),
            // Deprecated legacy alias — remove one release after S1.
            thinking_called_count: String(a.reasoningCount),
          }
        : {}),
    },
    statePatch: {
      "current.last_commit_at": input.lastProgressAt,
      "current.loc_added": locAdded,
      "current.loc_removed": locRemoved,
      ...(a
        ? {
            "current.tools_called_count": a.toolsCalled,
            "current.text_chunk_count": a.textChunks,
            "current.reasoning_events": a.reasoningCount,
            "current.reasoning_tokens": a.reasoningTokens,
            "current.waiting_count": a.waiting,
            "current.input_tokens": a.inputTokens,
            "current.output_tokens": a.outputTokens,
            "current.cost_usd": a.costUsd,
            "current.context_tokens": a.contextTokens,
          }
        : {}),
    },
  };
}

/**
 * Build the `type=heartbeat` firehose envelope, composing jsonl-log's
 * {@link buildRecord}. Mirrors the bash `jsonl_log_append_shared` call: the
 * `msg` is `activity:<activity> t+<elapsed>` and the extras carry the same vitals —
 * activity, elapsed (HH:MM:SS), cpu/rss as integer strings, and the escaped
 * last_stream_line. Identity (worker/issue/attempt) rides the standard
 * envelope fields. The heartbeat never writes the clean agent lane (#243), so
 * this record is only ever appended to the firehose.
 */
export function buildHeartbeatRecord(
  state: HeartbeatState,
  elapsedSeconds: number,
  vitals: HeartbeatVitals,
  ts: string,
  identity: FirehoseIdentity = {},
): JsonlLogRecord {
  const activity = state.activity === "" ? "?" : state.activity;
  const elapsedFmt = formatElapsed(elapsedSeconds);
  const stream = escapeStreamLine(state.lastStreamLine);
  return buildRecord("heartbeat", `activity:${activity} t+${elapsedFmt}`, ts, {
    worker: identity.worker ?? "",
    issue: identity.issue ?? 0,
    attempt: identity.attempt ?? 0,
    extra: {
      activity,
      elapsed: elapsedFmt,
      cpu: String(vitals.cpu),
      rss: String(vitals.rss),
      last_stream_line: stream,
    },
  });
}

/** Injected per-tick IO: re-read state, read process vitals, get a clock. */
export interface HeartbeatTickIO {
  /** Re-read `current.activity` / `current.last_stream_line` from afk.state.toon. */
  readState: () => HeartbeatState;
  /** Best-effort cpu/rss from `ps` against the orchestrator pid. */
  readVitals: () => HeartbeatVitals;
  /** Now, in epoch seconds (bash `date +%s`). */
  nowEpoch: () => number;
  /** Append one plain line to afk.log (the IO adds no formatting). */
  appendIterLog: (line: string) => void;
  /** Append one firehose record. Omitted when no firehose lane is configured. */
  appendFirehose?: (record: JsonlLogRecord) => void;
  /** ISO timestamp for the firehose envelope `ts` (bash `date -Is`). */
  nowIso?: () => string;
}

export interface HeartbeatTickOptions {
  startedEpoch: number;
  identity?: FirehoseIdentity;
}

/**
 * Run one heartbeat emit, mirroring bash `heartbeat_emit_once`: re-read state,
 * read vitals, compute elapsed from the injected clock, append the plain vitals
 * line to afk.log, and — only when a firehose sink is present — append the
 * matching `type=heartbeat` envelope. Pure decision logic over injected IO; no
 * sleeping, no spawning, no `ps`, no `Date.now()`.
 */
export function emitHeartbeatTick(io: HeartbeatTickIO, options: HeartbeatTickOptions): void {
  const state = io.readState();
  const vitals = io.readVitals();
  const elapsedSeconds = io.nowEpoch() - options.startedEpoch;

  io.appendIterLog(
    formatVitalsLine({
      activity: state.activity,
      elapsedSeconds,
      lastStreamLine: state.lastStreamLine,
      cpu: vitals.cpu,
      rss: vitals.rss,
    }),
  );

  if (io.appendFirehose) {
    const ts = (io.nowIso ?? (() => ""))();
    io.appendFirehose(buildHeartbeatRecord(state, elapsedSeconds, vitals, ts, options.identity));
  }
}

/**
 * Resolve the periodic interval from a `RED_AFK_HEARTBEAT_S` value, mirroring
 * the bash guard: a non-`[0-9]+` value falls back to the default; `0` (or any
 * value below 1) disables the periodic loop. Returns 0 when disabled.
 */
export function resolveIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined || !/^[0-9]+$/.test(raw)) return DEFAULT_HEARTBEAT_S;
  const n = Number(raw);
  return n > 0 ? n : 0;
}

/** True when the periodic loop should run (boundary markers always fire). */
export function isPeriodicEnabled(raw: string | undefined): boolean {
  return resolveIntervalSeconds(raw) > 0;
}
