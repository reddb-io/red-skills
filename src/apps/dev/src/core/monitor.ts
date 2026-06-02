// Port of the NON-TTY compact dashboard path of monitor.sh — the `--once` /
// RED_AFK_MONITOR_COMPACT one-shot. Given a list of live worker states, the
// history ledger events, and a `now` epoch, it produces the exact compact
// dashboard string: the 48h sparkline header line (reused from history.ts,
// NOT reimplemented) followed by one line per worker.
//
// The render is PURE — no clock, no filesystem, no ANSI. The caller injects the
// already-read state objects, the per-worker diff string (the
// worktree_diff_stats output), the liveness flag (state_is_live), and `now`.
// ANSI colouring and the TTY box-drawing `render_full` mode are out of scope:
// the agent-rendering contract (see monitor.sh's render_compact heredoc) maps
// the plain tags to colour downstream, and the TTY refresh loop belongs to the
// orchestration-loop slice.

import { buildSparkline, type HistoryRecord } from "./history.js";

/** The subset of a worker's current-iteration state the compact line reads. */
export interface CompactCurrent {
  /** Issue number; "" / "-" / "null" all mean "no issue in progress". */
  number: number | string;
  title: string;
  stage: string;
  /** Per-iteration start (current.started_at), an ISO/RFC string or "". */
  started_at: string;
}

/** The subset of afk.state.json the compact line reads. */
export interface CompactState {
  worker_id: string;
  pid: number;
  runner: string;
  /** Worker-process start; the elapsed fallback when current.started_at is "". */
  started_at: string;
  total: number;
  done: number;
  blocked: number;
  failed: number;
  current: CompactCurrent;
}

/** One worker as handed to the pure renderer. */
export interface CompactWorker {
  state: CompactState;
  /** Liveness from state_is_live(pid) + freshness, decided by the caller. */
  live: boolean;
  /** worktree_diff_stats output ("+A -R"); omitted when unavailable. */
  diff?: string;
}

const TITLE_MAX = 48;

/** Zero-padded HH:MM:SS, mirroring monitor.sh's fmt_dur. */
export function formatElapsed(seconds: number): string {
  const s = seconds < 0 ? 0 : seconds;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}

function isNoIssue(n: number | string): boolean {
  return n === "" || n === "-" || n === "null" || n === 0;
}

function elapsedSeconds(state: CompactState, now: number): number {
  const started = state.current.started_at || state.started_at;
  if (!started) return 0;
  const epoch = Math.floor(Date.parse(started) / 1000);
  if (Number.isNaN(epoch)) return 0;
  return now - epoch;
}

/**
 * Renders one compact worker line, ANSI-stripped, byte-for-byte matching
 * render_worker_compact's plain text:
 *
 *   w<id> [live|stale] <runner>  issues <done>/<total><flags><cur>
 *
 * The progress counter is labelled `issues <done>/<total>` — issues *closed*
 * over the queue total, NOT lines changed or a completion percentage. The bare
 * `<done>/<total> (<pct>%)` form read as "0% done / no code" while a worker had
 * already committed thousands of lines; lines live in the `+A -R` diff suffix
 * of <cur>, which is the real "is there work" signal.
 *
 * <flags> is ` blk:N` / ` fail:N` (each present only when > 0) and <cur> is
 * `  #<n> <title>  stage:<x>  HH:MM:SS<  +A -R>` when an issue is in progress,
 * or `  idle` otherwise. `now` is an epoch in seconds.
 */
export function renderWorkerCompactLine(worker: CompactWorker, now: number): string {
  const { state } = worker;
  const workerId = state.worker_id || "?";
  const tag = worker.live ? "live" : "stale";
  const runner = state.runner || "-";
  const total = state.total;
  const done = state.done;

  let flags = "";
  if (state.blocked > 0) flags += ` blk:${state.blocked}`;
  if (state.failed > 0) flags += ` fail:${state.failed}`;

  let cur: string;
  if (!isNoIssue(state.current.number)) {
    const title = state.current.title.slice(0, TITLE_MAX);
    const elapsed = formatElapsed(elapsedSeconds(state, now));
    const diff = worker.diff ? `  ${worker.diff}` : "";
    cur = `  #${state.current.number} ${title}  stage:${state.current.stage}  ${elapsed}${diff}`;
  } else {
    cur = "  idle";
  }

  return `${workerId} [${tag}] ${runner}  issues ${done}/${total}${flags}${cur}`;
}

/** Stable sort key — the worker-process start, oldest first (the bash glob is
 * lexical over the worker dirs; we order by started_at for determinism). */
function startedAtKey(worker: CompactWorker): string {
  return worker.state.started_at || worker.state.current.started_at || "";
}

/**
 * Renders the whole compact one-shot dashboard: the 48h sparkline header line
 * (reused from history.buildSparkline) followed by one line per worker, sorted
 * by started_at. With zero workers it emits the documented "(none …)" line
 * after the header, matching render_compact's
 * `echo "workers: (none — /afk not running here)"`.
 */
export function renderCompactDashboard(
  workers: ReadonlyArray<CompactWorker>,
  events: ReadonlyArray<Pick<HistoryRecord, "event" | "epoch">>,
  now: number,
): string {
  const header = buildSparkline(events, now).line;
  if (workers.length === 0) {
    return `${header}\nworkers: (none — /afk not running here)`;
  }
  const sorted = [...workers].sort((a, b) =>
    startedAtKey(a) < startedAtKey(b) ? -1 : startedAtKey(a) > startedAtKey(b) ? 1 : 0,
  );
  const lines = sorted.map((w) => renderWorkerCompactLine(w, now));
  return `${header}\n${lines.join("\n")}`;
}
