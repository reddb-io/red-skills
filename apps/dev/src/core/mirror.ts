// Task-mirror modules for the native task surface (ported from lib/mirror.sh, issue #43).
//
// Read-only reflection of live AFK workers onto the runner's native task list.
// Three layers, the diff/map ones pure:
//
//   reader      readWorkers(states) — normalizes raw afk.state.toon reads (keyed
//     worker_id:issue) into one WorkerRecord per worker that currently owns a
//     task. Idle workers (no current issue) own no task and are omitted. Liveness
//     is supplied by the caller via each state's `live` flag, so this stays pure.
//
//   reconciler  mirrorReconcile(desired, tracked) — pure diff between the desired
//     worker set and the tracked-task set, keyed by "worker_id:issue" so parallel
//     workers each get one task and re-runs never duplicate. No I/O.
//
//   sink map    mirrorPlan(desired, tracked) — maps each operation to a harness
//     call descriptor (TaskCreate / TaskUpdate). Idempotent: empty plan when
//     nothing changed.
//
// `codexSinkPlan` is the Codex fallback (ADR 0003): native surface → the shared
// plan; no native surface (today) → empty plan plus a one-line dashboard notice.

import type { AfkState } from "../types/state.js";

/** Terminal = anything but "running" (gone = pid dead, blocked = terminal failure). */
export type WorkerStatus = "running" | "gone" | "blocked";

/**
 * Ordered macro-lifecycle phases (issue #811), 1-based position out of 5. The
 * index drives the calm `n/5` prefix in the task title; the terminal `blocked`
 * is deliberately NOT in this list — it carries no position (edge decision 1:
 * `[blocked]`, never `3/5 blocked`).
 */
export const AFK_PHASE_ORDER = ["setup", "coding", "validating", "merging", "done"] as const;

/**
 * The landing steps, which are `merging` seen from close up.
 *
 * The orchestrator stamps `gate`, `push-pr`, `merge` and `cascade` as it lands,
 * and each is a real step worth naming in the fine `phase·step` cell. None of
 * them is a macro phase: a bar that grew a cell per landing step would say a
 * Worker regressed every time it entered one.
 */
const LANDING_PHASES = new Set(["gate", "push-pr", "merge", "cascade"]);

/**
 * The phase a bar, a title and a duration model all agree on. PURE.
 *
 * **One namer, because three readers disagreeing about what phase a Worker is in
 * is three different Workers on one screen.** The lifecycle bar, the mirror title
 * and the per-phase duration ledger each need the coarse answer, and each
 * derived it separately before this existed. An out-of-vocab phase (`boot`,
 * `blocked`, `terminal`) is returned unchanged — it has no position, and
 * inventing one is worse than having none.
 */
export function macroPhase(phase: string): string {
  return isLandingPhase(phase) ? "merging" : phase;
}

/** True when `phase` is one of the landing steps {@link macroPhase} folds. PURE. */
export function isLandingPhase(phase: string): boolean {
  return LANDING_PHASES.has(phase);
}

/**
 * The macro phases that COST time, in order — the duration model's vocabulary.
 *
 * `done` is dropped: it is a state a Worker arrives at, not a span it spends, so
 * nothing is ever observed leaving it and no median of it could exist.
 */
export const AFK_COSTED_PHASE_ORDER: readonly string[] = AFK_PHASE_ORDER.slice(0, -1);

/**
 * Build the calm macro-phase task title: `w<id> [<n>/5 <phase>] #<issue> <slug>`.
 * A phase inside {@link AFK_PHASE_ORDER} renders its 1-based `n/5` position; any
 * other non-empty phase (the terminal `blocked`) drops the `n/5` → `[<phase>]`;
 * an empty phase drops the bracket entirely. The leading `worker_id` already
 * carries its `w` prefix.
 */
export function mirrorTitle(
  worker_id: string,
  issue: number,
  phase: string,
  slug: string,
): string {
  const idx = (AFK_PHASE_ORDER as readonly string[]).indexOf(phase);
  const bracket = idx >= 0 ? `[${idx + 1}/5 ${phase}]` : phase ? `[${phase}]` : "";
  const head = bracket ? `${worker_id} ${bracket}` : worker_id;
  return `${head} #${issue} ${slug}`.trimEnd();
}

/** One normalized live/crashed worker that maps to a task. */
export interface WorkerRecord {
  worker_id: string;
  issue: number;
  title: string;
  /** Short branch-slug for the title (`current.slug`, falling back to title). */
  slug: string;
  activity: string;
  /** Macro-lifecycle phase (drives the title's `n/5` prefix, issue #811). */
  phase: string;
  started_at: string;
  status: WorkerStatus;
}

/** A currently-tracked task. `key` is "worker_id:issue". */
export interface TrackedTask {
  key: string;
  activity: string;
  /** Last-seen macro phase, parsed back from the task title (issue #811). A
   * tracked task missing it (older sessions) compares as "" and re-titles on the
   * next observed phase. */
  phase?: string;
}

/** An operation emitted by the reconciler. */
export interface MirrorOp {
  op: "create" | "update" | "complete";
  key: string;
  worker_id?: string;
  issue?: number;
  title?: string;
  slug?: string;
  activity?: string;
  phase?: string;
  status?: "running";
  result?: "completed" | "failed";
}

/** A harness call descriptor consumed by the sink. */
export interface MirrorCall {
  call: "TaskCreate" | "TaskUpdate";
  key: string;
  title?: string;
  description?: string;
  state?: "in_progress" | "completed" | "failed";
}

/** Raw state read for one worker dir, paired with caller-computed liveness. */
export interface WorkerStateRead {
  state: AfkState;
  live: boolean;
}

function mirrorKey(worker_id: string, issue: number): string {
  return `${worker_id}:${issue}`;
}

/**
 * Normalize raw state reads into the desired worker set (mirror_read_workers).
 * A record is emitted only when the state carries a current issue number (an idle
 * worker between issues owns no task). Liveness is injected via `read.live`, so
 * this is pure: live → running, not live → gone (stale, surfaced terminal).
 */
export function readWorkers(reads: readonly WorkerStateRead[]): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  for (const { state, live } of reads) {
    const number = state.current.number;
    if (number === "" || number === null || number === undefined) continue;
    const issue = typeof number === "number" ? number : Number(number);
    if (!Number.isFinite(issue)) continue;
    const phase = state.current.phase;
    out.push({
      worker_id: state.worker_id,
      issue,
      title: state.current.title,
      slug: state.current.slug || state.current.title,
      activity: state.current.activity,
      phase,
      started_at: state.current.started_at || state.started_at,
      // A dead worker whose last macro phase is the terminal `blocked` is a
      // FAILURE (→ task failed); any other dead worker is a normal completion.
      status: live ? "running" : phase === "blocked" ? "blocked" : "gone",
    });
  }
  return out;
}

/**
 * Pure diff between the desired worker set and the tracked-task set, keyed by
 * "worker_id:issue" (mirror_reconcile). Ordering mirrors the bash: desired-driven
 * ops first (in desired order), then tracked keys with no desired worker.
 *
 *   running, key absent       → create
 *   running, key tracked, activity moved → update
 *   running, key tracked, same activity  → no-op
 *   terminal (gone/blocked), key tracked → complete (failed if blocked, else completed)
 *   terminal, key untracked   → ignored
 *   tracked key, no desired worker → complete (result completed)
 */
export function mirrorReconcile(
  desired: readonly WorkerRecord[],
  tracked: readonly TrackedTask[],
): MirrorOp[] {
  const trackedMap = new Map<string, TrackedTask>();
  for (const t of tracked) trackedMap.set(t.key, t);
  const desiredKeys = new Set(desired.map((w) => mirrorKey(w.worker_id, w.issue)));

  const ops: MirrorOp[] = [];

  for (const w of desired) {
    const key = mirrorKey(w.worker_id, w.issue);
    const cur = trackedMap.get(key);
    if (w.status === "running") {
      if (cur === undefined) {
        ops.push({
          op: "create",
          key,
          worker_id: w.worker_id,
          issue: w.issue,
          title: w.title,
          slug: w.slug,
          activity: w.activity,
          phase: w.phase,
          status: "running",
        });
      } else if (cur.activity !== w.activity || (cur.phase ?? "") !== w.phase) {
        // The title tracks the macro PHASE, the description the micro ACTIVITY — a
        // change to either re-emits an update (the sink rewrites whichever moved).
        ops.push({
          op: "update",
          key,
          worker_id: w.worker_id,
          issue: w.issue,
          title: w.title,
          slug: w.slug,
          activity: w.activity,
          phase: w.phase,
          status: "running",
        });
      }
    } else if (cur !== undefined) {
      ops.push({
        op: "complete",
        key,
        worker_id: w.worker_id,
        issue: w.issue,
        slug: w.slug,
        // Terminal failure surfaces the `blocked` phase in the title; a normal
        // completion needs no title rewrite (state-only TaskUpdate).
        phase: w.status === "blocked" ? "blocked" : "done",
        result: w.status === "blocked" ? "failed" : "completed",
      });
    }
  }

  for (const t of tracked) {
    if (!desiredKeys.has(t.key)) {
      ops.push({ op: "complete", key: t.key, result: "completed" });
    }
  }

  return ops;
}

/**
 * Map reconciler operations to harness call descriptors (mirror_plan). Idempotent:
 * an empty desired/tracked diff yields an empty plan.
 *
 *   create   → TaskCreate (in_progress), title "w<id> [<n>/5 <phase>] #<issue> <slug>"
 *   update   → TaskUpdate (in_progress) re-titling the macro phase + refreshing "activity: <x>"
 *   complete → TaskUpdate with state completed | failed (failed re-titles to [blocked])
 */
export function mirrorPlan(
  desired: readonly WorkerRecord[],
  tracked: readonly TrackedTask[],
): MirrorCall[] {
  const calls: MirrorCall[] = [];
  for (const op of mirrorReconcile(desired, tracked)) {
    if (op.op === "create") {
      calls.push({
        call: "TaskCreate",
        key: op.key,
        title: mirrorTitle(op.worker_id!, op.issue!, op.phase ?? "", op.slug ?? ""),
        description: `activity: ${op.activity}`,
        state: "in_progress",
      });
    } else if (op.op === "update") {
      // Rewrite the title (macro phase) AND refresh the description (micro activity)
      // — idempotent when only one moved, since the unchanged side re-renders to
      // the same string.
      calls.push({
        call: "TaskUpdate",
        key: op.key,
        title: mirrorTitle(op.worker_id!, op.issue!, op.phase ?? "", op.slug ?? ""),
        description: `activity: ${op.activity}`,
        state: "in_progress",
      });
    } else if (op.result === "failed" && op.worker_id !== undefined) {
      // Terminal failure: re-title to the `[blocked]` macro phase, flip to failed.
      calls.push({
        call: "TaskUpdate",
        key: op.key,
        title: mirrorTitle(op.worker_id, op.issue!, op.phase ?? "blocked", op.slug ?? ""),
        state: "failed",
      });
    } else {
      calls.push({ call: "TaskUpdate", key: op.key, state: op.result });
    }
  }
  return calls;
}

/** Result of the Codex sink decision. */
export interface CodexSinkResult {
  /** Call plan to apply against a native surface (empty when falling back). */
  plan: MirrorCall[];
  /** One-line dashboard fallback notice, present only when no native surface. */
  notice?: string;
}

export interface CodexSinkOptions {
  /** Whether this Codex exposes a native task/progress surface (default false). */
  nativeTaskAvailable?: boolean;
}

export const CODEX_NO_NATIVE_NOTICE =
  "afk: Codex has no native task surface — mirroring via the monitor.sh dashboard instead.";

/**
 * Structured monitor signal emitted to stdout in the `--mirror-plan` output
 * when the Codex fallback path is active. Never confused with a task call
 * descriptor — `signal` is present, `call` is absent — so the consumer can
 * render it as a plain notice without attempting to apply it to a task surface.
 */
export interface MirrorFallbackNotice {
  signal: "fallback-notice";
  message: string;
}

/**
 * Codex half of the runner-specific Task-mirror sink (mirror_sink_codex). The
 * reader + reconciler are reused unchanged; only this sink is runner-specific.
 *
 *   native surface available → the shared mirrorPlan descriptors.
 *   no native surface (today, the default) → empty plan + one-line notice.
 *
 * Never throws: the fallback is a clean degrade, not an error.
 */
export function codexSinkPlan(
  desired: readonly WorkerRecord[],
  tracked: readonly TrackedTask[],
  options: CodexSinkOptions = {},
): CodexSinkResult {
  if (options.nativeTaskAvailable) {
    return { plan: mirrorPlan(desired, tracked) };
  }
  return { plan: [], notice: CODEX_NO_NATIVE_NOTICE };
}

// --- Host capability matrix (issue #886) -----------------------------------
//
// The Task mirror is per-runner by construction (ADR 0003/0015): there is NO
// shared native task API across the hosts, so a single cross-runner abstraction
// would be a fiction. `taskMirrorCapability` is a *classification*, not a
// dispatcher — it states what each host supports today and which explicit sink
// applies, leaving the three sinks (`mirrorPlan`, `codexSinkPlan`, headless
// none) separate. Reading the matrix never collapses the adapters into one.

/** The host/runner whose Task-mirror capability is being classified. */
export type TaskMirrorHost = "claude" | "codex" | "opencode";

/**
 * The progress surface a host drives today. Deliberately three distinct values,
 * never a single "supported: boolean", so the matrix cannot imply parity:
 *   native-task   — a first-class host task API (Claude Code TaskCreate/TaskUpdate).
 *   monitor-agent — no task API; the dashboard plus one read-only monitor agent.
 *   headless      — no host session at all; nothing to mirror into.
 */
export type TaskMirrorSurface = "native-task" | "monitor-agent" | "headless";

/** One host's Task-mirror capability — what it supports and how it surfaces. */
export interface TaskMirrorCapability {
  host: TaskMirrorHost;
  /** Which surface this host drives (see {@link TaskMirrorSurface}). */
  surface: TaskMirrorSurface;
  /** Whether an in-session agent drives the mirror tick at all. False = headless. */
  agentDriven: boolean;
  /** Whether the host exposes a native background-task API the mirror writes to. */
  nativeTaskApi: boolean;
  /** Operator-facing one-liner, in project vocabulary (Worker / Agent runner / …). */
  note: string;
}

/**
 * Classify a host's Task-mirror capability (issue #886). An explicit per-host
 * switch — NOT a generic registry — so adding or pretending a host is left an
 * obvious code edit, and an unknown host fails loudly rather than silently
 * inheriting the Claude native path. The honest, no-parity matrix:
 *
 *   claude   → native-task   — the Claude Code Agent runner drives the Task
 *                              mirror through TaskCreate / TaskUpdate.
 *   codex    → monitor-agent — the Codex Agent runner has no task API; the Task
 *                              mirror falls back to the dashboard plus one
 *                              read-only Codex monitor agent (see codexSinkPlan).
 *   opencode → headless      — the OpenCode runner is an API-auth Worker with no
 *                              host session, so there is no surface to mirror into.
 */
export function taskMirrorCapability(host: string): TaskMirrorCapability {
  const normalized = host.trim().toLowerCase();
  switch (normalized) {
    case "claude":
      return {
        host: "claude",
        surface: "native-task",
        agentDriven: true,
        nativeTaskApi: true,
        note: "Claude Code Agent runner: native Task mirror via TaskCreate/TaskUpdate.",
      };
    case "codex":
      return {
        host: "codex",
        surface: "monitor-agent",
        agentDriven: true,
        nativeTaskApi: false,
        note: "Codex Agent runner: no task API — dashboard fallback plus one read-only Codex monitor agent.",
      };
    case "opencode":
      return {
        host: "opencode",
        surface: "headless",
        agentDriven: false,
        nativeTaskApi: false,
        note: "OpenCode runner: headless API-auth Worker, no host session and no Task mirror surface.",
      };
    default:
      throw new Error(`taskMirrorCapability: unknown host '${host}'`);
  }
}
