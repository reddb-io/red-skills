// worker-display-record — the Worker's own state, said in the host's vocabulary (#3097).
//
// **The project publishes; the daemon stores; a surface prints.** Everything a
// dashboard shows about a Worker is decided HERE, in the process that owns the
// work, because that is the only process with the semantics to decide it: what a
// phase is, which of five it is, whether an origin is `afk` or `go`, and how long
// the work has left. The daemon stores the record without reading a field of it
// (ADR 0130 rule 3) and the render draws what it was handed.
//
// **The field names are the statusline's own.** `workerFields` (red-castle's
// monitor) already names every one of these signals for the line the operator
// reads locally; a second vocabulary for the same facts would mean a reader
// comparing the dashboard against the statusline beside it was translating
// instead of comparing.
//
// **Absent is `null`, never a zero** — the record's own rule, applied where this
// module can tell the difference. A Worker holding no `eta` publishes `null`; a
// runner that never reports usage publishes `null` tokens rather than `0`, which
// would read as a Worker that spent nothing. A `0` tool count, by contrast, is a
// real measurement of a Worker that has called no tool yet, and is published as
// the zero it is.
//
// PURE.

import type { RedskilledWorkerDisplay } from "@reddb-io/redskilled/worker-display";
import { AFK_PHASE_ORDER, macroPhase } from "./mirror.js";
import type { AfkState } from "../types/state.js";

/** What only the caller knows: the estimate, and the instant it is answering at. */
export interface WorkerDisplayContext {
  /** Seconds of work expected to remain, or `null` when nothing may be claimed. */
  readonly etaSeconds: number | null;
  /** Now, in epoch milliseconds — the one clock this record is dated against. */
  readonly nowMs: number;
}

/** A trimmed string, or `null` — the record's absence, not an empty cell. */
function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** A count whose zero means "nothing has measured this yet". */
function measured(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A count whose zero is a real observation. */
function counted(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Proof-of-life the way the project spells it — the `hb=` cell. PURE.
 *
 * Seconds since the last stream event, not since the last commit: an exploring
 * Worker advances the former every few seconds and the latter not for an hour,
 * and the question `hb=` answers is "is anything still happening".
 */
function heartbeat(state: AfkState, nowMs: number): string | null {
  const last = state.current.last_event_at || state.current.last_commit_at;
  if (!last) return null;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.max(0, Math.round((nowMs - at) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

/**
 * One Worker's whole display record, from the state it already writes. PURE.
 *
 * The progress bar travels as two integers and never as a vocabulary: the macro
 * phase's position in {@link AFK_PHASE_ORDER}, and the length of that order. A
 * phase outside it (`boot`, `blocked`, `terminal`) publishes `null` for both, so
 * the render draws no bar rather than placing the Worker somewhere it is not.
 */
export function workerDisplayFromState(state: AfkState, context: WorkerDisplayContext): RedskilledWorkerDisplay {
  const current = state.current;
  const phase = text(current.phase);
  const position = phase == null ? -1 : (AFK_PHASE_ORDER as readonly string[]).indexOf(macroPhase(phase));
  const issue = current.number;
  const tokens = (current.input_tokens ?? 0) + (current.output_tokens ?? 0);
  return {
    runner: text(current.runner) ?? text(state.runner),
    model: text(current.model),
    effort: text(current.effort),
    origin: text(state.origin) ?? text(current.kind),
    issue: issue === "" || issue == null ? null : text(String(issue)),
    phase,
    // The momentary detail under the macro phase — `coding·impl`,
    // `validating·typecheck`. Both halves are load-bearing: the phase says where
    // in the pipeline, the step says what is happening right now.
    step: text(current.activity),
    phase_index: position < 0 ? null : position,
    phase_total: position < 0 ? null : AFK_PHASE_ORDER.length,
    failed: phase === "blocked" || state.failed > 0,
    heartbeat: heartbeat(state, context.nowMs),
    wait_kind: text(current.wait_kind),
    wait_subject: text(current.wait_subject),
    wait_pid: measured(current.wait_pid),
    wait_started_at: text(current.wait_started_at),
    wait_deadline: text(current.wait_deadline),
    wait_escalation: text(current.wait_escalation),
    // The WORK's start, not the process's: a Worker that finished one issue and
    // took another is one process and two spans, and the host can only see the
    // first. The render subtracts this from the payload's own `generated_at`.
    started_at: text(current.started_at) ?? text(state.started_at),
    context: measured(current.context_tokens),
    eta: context.etaSeconds,
    added: counted(current.loc_added),
    removed: counted(current.loc_removed),
    tokens: measured(tokens),
    tools: counted(current.tools_called_count),
    reasoning: counted(current.reasoning_events),
    text: counted(current.text_chunk_count),
  };
}
