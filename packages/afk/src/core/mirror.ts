// Task-mirror modules for the native task surface (ported from lib/mirror.sh, issue #43).
//
// Read-only reflection of live AFK workers onto the runner's native task list.
// Three layers, the diff/map ones pure:
//
//   reader      readWorkers(states) — normalizes raw afk.state.json reads (keyed
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

/** One normalized live/crashed worker that maps to a task. */
export interface WorkerRecord {
  worker_id: string;
  issue: number;
  title: string;
  stage: string;
  started_at: string;
  status: WorkerStatus;
}

/** A currently-tracked task. `key` is "worker_id:issue". */
export interface TrackedTask {
  key: string;
  stage: string;
}

/** An operation emitted by the reconciler. */
export interface MirrorOp {
  op: "create" | "update" | "complete";
  key: string;
  worker_id?: string;
  issue?: number;
  title?: string;
  stage?: string;
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
    out.push({
      worker_id: state.worker_id,
      issue,
      title: state.current.title,
      stage: state.current.stage,
      started_at: state.current.started_at || state.started_at,
      status: live ? "running" : "gone",
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
 *   running, key tracked, stage moved → update
 *   running, key tracked, same stage  → no-op
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
          stage: w.stage,
          status: "running",
        });
      } else if (cur.stage !== w.stage) {
        ops.push({
          op: "update",
          key,
          worker_id: w.worker_id,
          issue: w.issue,
          title: w.title,
          stage: w.stage,
          status: "running",
        });
      }
    } else if (cur !== undefined) {
      ops.push({
        op: "complete",
        key,
        worker_id: w.worker_id,
        issue: w.issue,
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
 *   create   → TaskCreate (in_progress), title "#<issue> <worker_id> — <title>"
 *   update   → TaskUpdate (in_progress) refreshing "stage: <x>"
 *   complete → TaskUpdate with state completed | failed
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
        title: `#${op.issue} ${op.worker_id} — ${op.title}`,
        description: `stage: ${op.stage}`,
        state: "in_progress",
      });
    } else if (op.op === "update") {
      calls.push({
        call: "TaskUpdate",
        key: op.key,
        description: `stage: ${op.stage}`,
        state: "in_progress",
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
