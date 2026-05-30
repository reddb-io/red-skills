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

/** Per-tick state re-read from afk.state.json. */
export interface HeartbeatState {
  stage: string;
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
  stage: string;
  elapsedSeconds: number;
  lastStreamLine: string;
  cpu: number;
  rss: number;
}

/**
 * The exact periodic vitals line appended to afk.log, byte-matching the bash
 * `printf '[heartbeat] stage:%s t+%s last_stream_line="%s" cpu=%s%% rss=%sM\n'`.
 * Returned without the trailing newline; the IO layer adds it.
 */
export function formatVitalsLine(input: VitalsLineInput): string {
  const stage = input.stage === "" ? "?" : input.stage;
  const elapsedFmt = formatElapsed(input.elapsedSeconds);
  const stream = escapeStreamLine(input.lastStreamLine);
  return `[heartbeat] stage:${stage} t+${elapsedFmt} last_stream_line="${stream}" cpu=${input.cpu}% rss=${input.rss}M`;
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

export interface FirehoseIdentity {
  worker?: string;
  issue?: number | string;
  attempt?: number | string;
}

/**
 * Build the `type=heartbeat` firehose envelope, composing jsonl-log's
 * {@link buildRecord}. Mirrors the bash `jsonl_log_append_shared` call: the
 * `msg` is `stage:<stage> t+<elapsed>` and the extras carry the same vitals —
 * stage, elapsed (HH:MM:SS), cpu/rss as integer strings, and the escaped
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
  const stage = state.stage === "" ? "?" : state.stage;
  const elapsedFmt = formatElapsed(elapsedSeconds);
  const stream = escapeStreamLine(state.lastStreamLine);
  return buildRecord("heartbeat", `stage:${stage} t+${elapsedFmt}`, ts, {
    worker: identity.worker ?? "",
    issue: identity.issue ?? 0,
    attempt: identity.attempt ?? 0,
    extra: {
      stage,
      elapsed: elapsedFmt,
      cpu: String(vitals.cpu),
      rss: String(vitals.rss),
      last_stream_line: stream,
    },
  });
}

/** Injected per-tick IO: re-read state, read process vitals, get a clock. */
export interface HeartbeatTickIO {
  /** Re-read `current.stage` / `current.last_stream_line` from afk.state.json. */
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
      stage: state.stage,
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
