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
import { encodeToon, type ToonValue } from "./toon.js";
import type { LivenessVerdict } from "@reddb-io/red-castle";

/** The subset of a worker's current-iteration state the compact line reads. */
export interface CompactCurrent {
  /** Issue number; "" / "-" / "null" all mean "no issue in progress". */
  number: number | string;
  title: string;
  stage: string;
  /** Macro-lifecycle phase (issue #811) — the calm task-mirror title signal,
   * distinct from the micro `stage`. Optional so fixtures stay terse; absent
   * reads as "" (no `n/5` bracket). */
  phase?: string;
  /** Short branch-slug for the title; absent falls back to `title`. */
  slug?: string;
  /** Per-iteration start (current.started_at), an ISO/RFC string or "". */
  started_at: string;
  /** Cost group (ADR 0065) — cumulative per-worker token spend / USD. Optional so
   * the dashboard's compact-current constructor and fixtures stay terse; absent
   * reads as 0. */
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  /** WorkerVitals activity counters (ADR 0065), shown as the operator's
   * tie-breaker when the agent lane is quiet but the worker pid still lives. */
  tools_called_count?: number;
  text_chunk_count?: number;
  reasoning_events?: number;
  waiting_count?: number;
}

/** The subset of afk.state.json the compact line reads. */
export interface CompactState {
  worker_id: string;
  pid: number;
  runner: string;
  /** Worker-process start; the elapsed fallback when current.started_at is "". */
  started_at: string;
  /** Spawn-time provenance from `state.origin` (e.g. `"afk"` | `"go"`).
   * Absent / `""` means unknown (pre-field or origin flag not passed). The
   * dashboard header aggregates non-empty values into per-source counts. */
  origin?: string;
  total: number;
  done: number;
  blocked: number;
  failed: number;
  current: CompactCurrent;
}

/** One worker as handed to the pure renderer. */
export interface CompactWorker {
  state: CompactState;
  /** Red-castle evaluator verdict (ADR 0083 §3). The primary liveness signal for
   * all rendering surfaces; `liveness`, `live`, and `pidLive` are derived from
   * it. Older test stubs may omit it — the fallbacks below still apply. */
  livenessVerdict?: LivenessVerdict;
  /** Explicit liveness verdict from the shared Worker state reader. Derived from
   * `livenessVerdict` when present. Older tests may omit it and still fall back
   * to `live` / `pidLive`. */
  liveness?: "active" | "quiet-but-live" | "dead";
  /** True when the evaluator says "alive". Used for the `[live]` badge.
   * When false but {@link pidLive} is true, the badge renders as `[quiet]`. */
  live: boolean;
  /** True when the worker's pid identity matches regardless of freshness.
   * Absent / false collapses to the `[stale]` (dead/finished) badge. */
  pidLive?: boolean;
  /** Added lines of the attempt's diff (committed + uncommitted, from the
   * branch's merge-base with origin/main). Defaults to 0 when unavailable —
   * the diff volume is rendered unconditionally, so this is never omitted. */
  diffAdded?: number;
  /** Removed lines of the attempt's diff. Defaults to 0 — see {@link diffAdded}. */
  diffRemoved?: number;
  /** Total newline-terminated lines currently observed in the attempt's
   * `afk.log`, read via the monitor's persistent cursor. */
  logLines?: number;
  /** New log lines observed since the previous monitor tick for this log file. */
  logNewLines?: number;
}

/** Per-slot visibility record for a non-closed supervisor slot, sourced from the
 * supervisor-published state file (never from the supervisor log). Closed slots
 * are omitted; only the slots needing operator attention carry a record. */
export interface SlotDetail {
  index: number;
  /** "open" = circuit tripped, awaiting half-open cooldown
   *  "half-open" = probe worker spawned, awaiting success/failure verdict
   *  "idle-parked" = clean drain with empty queue; auto-unparks on next work */
  status: "open" | "half-open" | "idle-parked";
  /** Epoch seconds when the half-open probe is scheduled (open slots only). */
  retryAt?: number;
}

export interface FleetState {
  ts: string;
  epoch: number;
  /**
   * Epoch seconds of the last non-abandoned tick (#579). 0 / absent on state
   * files written before this field was added — treated as null (healthy) by
   * the watchdog.
   */
  lastProgressEpoch?: number;
  /** Runner the fleet was launched with (default "" for pre-#407 state files). */
  runner: string;
  readyForAgent: number;
  slotsBusy: number;
  slotsFree: number;
  slotsTotal: number;
  slotsParked: number;
  spawnsThisTick: number;
  /** Per-slot details for non-closed slots. Absent/empty = all slots closed.
   * Absent on state files written before this field was added (#630). */
  slotDetails?: SlotDetail[];
}

export const FLEET_STALE_AFTER_S = 180;

/** Formats a diff volume as the `+A -R` suffix the dashboard renders on every
 * worker line (and aggregates into the header). Always produced, even for a
 * zero diff (`+0 -0`) — the volume is shown unconditionally. */
export function formatDiff(added: number, removed: number): string {
  const a = added > 0 ? added : 0;
  const r = removed > 0 ? removed : 0;
  return `+${a} -${r}`;
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

export function renderFleetLine(fleet: FleetState, now: number): string {
  const age = now - fleet.epoch;
  const stale = age >= FLEET_STALE_AFTER_S;
  const status = stale
    ? "wedged"
    : fleet.readyForAgent === 0 && fleet.slotsBusy === 0
      ? "idle"
      : "draining";
  return (
    `fleet [${status}] last ticked ${formatElapsed(age)} ago` +
    `  ready:${fleet.readyForAgent}` +
    `  slots busy:${fleet.slotsBusy} free:${fleet.slotsFree} parked:${fleet.slotsParked}` +
    `  spawns:${fleet.spawnsThisTick}`
  );
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
 *   w<id> [live|quiet|stale] <runner>  issues <done>/<total><flags><cur>
 *
 * The progress counter is labelled `issues <done>/<total>` — issues *closed*
 * over the queue total, NOT lines changed or a completion percentage. The bare
 * `<done>/<total> (<pct>%)` form read as "0% done / no code" while a worker had
 * already committed thousands of lines; lines live in the `+A -R` diff suffix,
 * which is the real "is there work" signal.
 *
 * <flags> is ` blk:N` / ` fail:N` (each present only when > 0) and <cur> is
 * `  #<n> <title>  stage:<x>  HH:MM:SS` when an issue is in progress, or `  idle`
 * otherwise. The `  +A -R` diff suffix is **always** appended (even idle, even
 * `+0 -0`) so the diff volume is never hidden. `now` is an epoch in seconds.
 */
/** The `live` / `quiet` / `stale` liveness badge, shared by the plain and TOON
 * renders so the two never drift.
 *
 * Primary path: evaluator verdict (`livenessVerdict`) — the single source of
 * truth (ADR 0083 §3). Fallback chain for older test stubs without the verdict:
 * `liveness` → `live` / `pidLive`.
 */
export function compactWorkerTag(worker: CompactWorker): "live" | "quiet" | "stale" {
  if (worker.livenessVerdict !== undefined) {
    const s = worker.livenessVerdict.status;
    if (s === "alive") {
      return worker.livenessVerdict.laneFresh ? "live" : "quiet";
    }
    if (s === "unknown") return "quiet";
    return "stale";
  }
  return worker.liveness === "active"
    ? "live"
    : worker.liveness === "quiet-but-live"
      ? "quiet"
      : worker.liveness === "dead"
        ? "stale"
        : worker.live
          ? "live"
          : worker.pidLive
            ? "quiet"
            : "stale";
}

export function renderWorkerCompactLine(worker: CompactWorker, now: number): string {
  const { state } = worker;
  const workerId = state.worker_id || "?";
  const tag = compactWorkerTag(worker);
  const runner = state.runner || "-";
  const total = state.total;
  const done = state.done;

  let flags = "";
  if (state.blocked > 0) flags += ` blk:${state.blocked}`;
  if (state.failed > 0) flags += ` fail:${state.failed}`;

  const diff = `  ${formatDiff(worker.diffAdded ?? 0, worker.diffRemoved ?? 0)}`;

  // Cost group (ADR 0065): per-worker token spend, shown only when the runner
  // streamed usage (codex/opencode). `$cost` only when the runner reports USD.
  const it = state.current.input_tokens ?? 0;
  const ot = state.current.output_tokens ?? 0;
  const cu = state.current.cost_usd ?? 0;
  const costFrag = it > 0 || ot > 0 ? `  tok:${it}/${ot}${cu > 0 ? ` $${cu.toFixed(2)}` : ""}` : "";
  const tools = state.current.tools_called_count ?? 0;
  const text = state.current.text_chunk_count ?? 0;
  const reasoning = state.current.reasoning_events ?? 0;
  const waiting = state.current.waiting_count ?? 0;
  const hasVitals = tools > 0 || text > 0 || reasoning > 0 || waiting > 0;
  const vitalsFrag = hasVitals
    ? `  tools:${tools} reason:${reasoning} text:${text}${waiting > 0 ? ` wait:${waiting}` : ""}`
    : "";
  const logFrag =
    worker.logLines !== undefined
      ? `  log:${worker.logLines}${worker.logNewLines !== undefined ? `(+${worker.logNewLines})` : ""}`
      : "";

  let cur: string;
  if (!isNoIssue(state.current.number)) {
    const title = state.current.title.slice(0, TITLE_MAX);
    const elapsed = formatElapsed(elapsedSeconds(state, now));
    cur = `  #${state.current.number} ${title}  stage:${state.current.stage}  ${elapsed}${diff}${costFrag}${vitalsFrag}${logFrag}`;
  } else {
    cur = `  idle${diff}${logFrag}`;
  }

  return `${workerId} [${tag}] ${runner}  issues ${done}/${total}${flags}${cur}`;
}

/**
 * Renders per-slot detail lines for any non-closed slot in the fleet.
 * Returns one line per non-closed slot:
 *   open      → "  slot N open  retry in HH:MM:SS"
 *   half-open → "  slot N half-open  (probing)"
 *   idle-parked → "  slot N idle-parked  (queue empty)"
 * Returns an empty array when all slots are closed or slotDetails is absent.
 * `now` is epoch seconds.
 */
export function renderSlotDetails(fleet: FleetState, now: number): string[] {
  if (!fleet.slotDetails || fleet.slotDetails.length === 0) return [];
  return fleet.slotDetails.map((d) => {
    if (d.status === "half-open") {
      return `  slot ${d.index} half-open  (probing)`;
    }
    if (d.status === "idle-parked") {
      return `  slot ${d.index} idle-parked  (queue empty)`;
    }
    // open: show next retry countdown
    if (d.retryAt !== undefined) {
      const waitS = Math.max(0, d.retryAt - now);
      return `  slot ${d.index} open  retry in ${formatElapsed(waitS)}`;
    }
    return `  slot ${d.index} open`;
  });
}

/** Stable sort key — the worker-process start, oldest first (the bash glob is
 * lexical over the worker dirs; we order by started_at for determinism). */
function startedAtKey(worker: CompactWorker): string {
  return worker.state.started_at || worker.state.current.started_at || "";
}

/**
 * Renders the whole compact one-shot dashboard: the 48h sparkline header line
 * (reused from history.buildSparkline) — suffixed with the fleet-wide diff total
 * `   Δ fleet +A -R` (summed over every worker, **always** present, even with
 * zero workers / a zero diff) — followed by one line per worker, sorted by
 * started_at. With zero workers it emits the documented "(none …)" line after
 * the header, matching render_compact's
 * `echo "workers: (none — /afk not running here)"`.
 */
export function renderCompactDashboard(
  workers: ReadonlyArray<CompactWorker>,
  events: ReadonlyArray<Pick<HistoryRecord, "event" | "epoch">>,
  now: number,
  fleet?: FleetState | null,
): string {
  let added = 0;
  let removed = 0;
  // Per-source counts: aggregate state.origin from all workers (not just live
  // ones — liveness filtering happens at the collection layer). Only non-empty
  // origins are counted; both surfaces read from the same state.origin field.
  const sourceMap = new Map<string, number>();
  for (const w of workers) {
    added += w.diffAdded ?? 0;
    removed += w.diffRemoved ?? 0;
    const origin = w.state.origin;
    if (origin) sourceMap.set(origin, (sourceMap.get(origin) ?? 0) + 1);
  }
  const sourceFrag =
    sourceMap.size > 0
      ? "  " +
        [...sourceMap.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([o, c]) => `${o}=${c}`)
          .join(" ")
      : "";
  const header = `${buildSparkline(events, now).line}   Δ fleet ${formatDiff(added, removed)}${sourceFrag}`;
  let prefix: string;
  if (fleet) {
    const fleetLine = renderFleetLine(fleet, now);
    const details = renderSlotDetails(fleet, now);
    prefix = details.length > 0
      ? `${header}\n${fleetLine}\n${details.join("\n")}`
      : `${header}\n${fleetLine}`;
  } else {
    prefix = header;
  }
  if (workers.length === 0) {
    return `${prefix}\nworkers: (none — /afk not running here)`;
  }
  const sorted = [...workers].sort((a, b) =>
    startedAtKey(a) < startedAtKey(b) ? -1 : startedAtKey(a) > startedAtKey(b) ? 1 : 0,
  );
  const lines = sorted.map((w) => renderWorkerCompactLine(w, now));
  return `${prefix}\n${lines.join("\n")}`;
}

/** Per-source counts from `state.origin` across all workers (#930), aggregated
 * identically to the plain dashboard so both surfaces agree. Sorted by origin. */
function sourceCountRows(workers: ReadonlyArray<CompactWorker>): Array<{ origin: string; count: number }> {
  const sourceMap = new Map<string, number>();
  for (const w of workers) {
    const origin = w.state.origin;
    if (origin) sourceMap.set(origin, (sourceMap.get(origin) ?? 0) + 1);
  }
  return [...sourceMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([origin, count]) => ({ origin, count }));
}

/** One TOON worker row — a flat, uniform record so the array renders as a single
 * header row plus bare CSV rows. Empty/idle fields stay present (uniform shape).
 * The `state` column carries the same live/quiet/stale badge as the plain line. */
function toonWorkerRow(worker: CompactWorker, now: number): Record<string, ToonValue> {
  const { state } = worker;
  const noIssue = isNoIssue(state.current.number);
  return {
    id: state.worker_id || "?",
    state: compactWorkerTag(worker),
    runner: state.runner || "-",
    issue: noIssue ? "-" : state.current.number,
    stage: noIssue ? "idle" : state.current.stage,
    done: state.done,
    total: state.total,
    blocked: state.blocked,
    failed: state.failed,
    elapsed: formatElapsed(elapsedSeconds(state, now)),
    added: worker.diffAdded ?? 0,
    removed: worker.diffRemoved ?? 0,
    in_tok: state.current.input_tokens ?? 0,
    out_tok: state.current.output_tokens ?? 0,
    cost_usd: state.current.cost_usd ?? 0,
    tools: state.current.tools_called_count ?? 0,
    reason: state.current.reasoning_events ?? 0,
    text: state.current.text_chunk_count ?? 0,
    wait: state.current.waiting_count ?? 0,
    log: worker.logLines ?? 0,
  };
}

/**
 * The default agent-facing monitor render (PRD #928 / ADR 0081): the same live
 * inputs as {@link renderCompactDashboard}, serialized as TOON. Cheap by design —
 * the worker table names its columns ONCE instead of repeating mnemonics per
 * line, the fleet/diff aggregates are pre-computed, the per-source `state.origin`
 * counts (#930) survive as a `sources` table, and an empty fleet renders the
 * definitive `workers[0]:` empty state rather than a prose "(none …)".
 */
export function renderCompactDashboardToon(
  workers: ReadonlyArray<CompactWorker>,
  events: ReadonlyArray<Pick<HistoryRecord, "event" | "epoch">>,
  now: number,
  fleet?: FleetState | null,
): string {
  let added = 0;
  let removed = 0;
  for (const w of workers) {
    added += w.diffAdded ?? 0;
    removed += w.diffRemoved ?? 0;
  }

  const root: Record<string, ToonValue> = {
    sparkline: buildSparkline(events, now).line,
    diff_added: added,
    diff_removed: removed,
    sources: sourceCountRows(workers),
  };

  if (fleet) {
    const age = now - fleet.epoch;
    const stale = age >= FLEET_STALE_AFTER_S;
    const status = stale
      ? "wedged"
      : fleet.readyForAgent === 0 && fleet.slotsBusy === 0
        ? "idle"
        : "draining";
    root.fleet = {
      status,
      ticked_ago: formatElapsed(age),
      ready: fleet.readyForAgent,
      slots_busy: fleet.slotsBusy,
      slots_free: fleet.slotsFree,
      slots_parked: fleet.slotsParked,
      spawns: fleet.spawnsThisTick,
      slot_details: (fleet.slotDetails ?? []).map((d) => ({
        index: d.index,
        status: d.status,
        retry_in:
          d.status === "open" && d.retryAt !== undefined
            ? formatElapsed(Math.max(0, d.retryAt - now))
            : "-",
      })),
    };
  }

  const sorted = [...workers].sort((a, b) =>
    startedAtKey(a) < startedAtKey(b) ? -1 : startedAtKey(a) > startedAtKey(b) ? 1 : 0,
  );
  root.workers = sorted.map((w) => toonWorkerRow(w, now));

  return encodeToon(root);
}
