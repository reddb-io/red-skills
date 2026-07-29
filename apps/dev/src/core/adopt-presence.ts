// core/adopt-presence.ts — worker presence for the `/requeue --adopt-branch`
// no-agent landing lane (ADR 0055, issue #1306).
//
// The adopt-landing lane validates and lands a hand-done branch WITHOUT running
// an AFK worker, so while its gate ran the run was INVISIBLE on the live-worker
// surfaces (statusline / `/afk monitor`) — a maintainer watching the fleet saw
// nothing for the minute-plus the feedback gate takes. This seeds a SHORT-LIVED
// worker-presence state file under the canonical workers root, stamped
// `origin="requeue"`, so the (origin-agnostic) Worker state reader renders one
// row for the run; the row advances through the validate → land stages and is
// marked not-live + torn down in a `finally` on EVERY exit path (landed,
// parked, or thrown).
//
// PURE orchestration over injected IO: the seam that seeds / advances / tears
// down the state file is a port, so the whole lifecycle is unit-testable with
// zero disk. No reader changes — the reader already unions every worker-lane
// namespace and reads `origin` off the state (issue #1306).

import { buildWorkerAttemptPath } from "./worker-paths.js";
import { workerStatePath } from "./state.js";

/** Spawn-time provenance stamped on an adopt-landing presence row, distinct from
 * `afk` / `go` / `urgent` so the monitor/statusline render its per-source count
 * as its own lane (issue #1306). */
export const REQUEUE_ORIGIN = "requeue";

/** Synthetic worker id for the adopt-landing presence row — a valid worker id
 * (`[A-Za-z0-9_-]+`) so {@link buildWorkerAttemptPath} accepts it. */
export const REQUEUE_ADOPT_WORKER = "requeue-adopt";

/** The single adopt-landing presence attempt is always attempt 1 (there is only
 * ever one presence row per adopt run). */
export const REQUEUE_ADOPT_ATTEMPT = 1;

/** The lifecycle stages an adopt-landing presence row advances through, in
 * order: the feedback gate (`validating`) then the land (`landing`). */
export type AdoptPresenceStage = "validating" | "landing";

/** The immutable identity + issue fields a {@link AdoptPresenceIo.seed} writes
 * onto the presence state file. */
export interface AdoptPresenceSeed {
  /** Absolute path of the presence `afk.state.toon`. */
  statePath: string;
  /** The attempt dir the state file (and its liveness lane) live in. */
  attemptDir: string;
  /** Synthetic worker id ({@link REQUEUE_ADOPT_WORKER}). */
  worker: string;
  /** The issue whose branch is being adopted. */
  issue: number;
  /** Issue title, for the rendered row. */
  title: string;
  /** Runner label stamped on the row. */
  runner: string;
  /** The stage the row is seeded at ({@link AdoptPresenceStage}). */
  stage: AdoptPresenceStage;
}

/**
 * Injected IO for one adopt-landing presence lifecycle. Every effect is a port
 * so {@link withAdoptPresence} is testable without touching disk.
 */
export interface AdoptPresenceIo {
  /** Seed the presence state file LIVE (pid + `origin` + identity + a first
   * liveness-lane record) so the reader renders the row immediately. */
  seed(input: AdoptPresenceSeed): void;
  /** Advance `current.activity` (and refresh liveness) as the run progresses.
   * Best-effort: a failed update must never fail the adopt landing. */
  setStage(statePath: string, stage: AdoptPresenceStage): Promise<void>;
  /** Mark the presence row not-live (`pid: 0`) and remove its attempt dir — the
   * `finally` teardown fired on every exit path. */
  teardown(statePath: string, attemptDir: string): Promise<void>;
}

/** Static inputs for one adopt-landing presence lifecycle. */
export interface AdoptPresenceParams {
  /** The `.red/tmp` dir under which the canonical `workers/` root lives. */
  tmpDir: string;
  issue: number;
  title: string;
  runner: string;
}

/** Handle passed to the wrapped body so it can advance the presence stage as it
 * crosses its own validate → land phases. */
export interface AdoptPresenceHandle {
  markStage(stage: AdoptPresenceStage): Promise<void>;
}

/**
 * Run `body` with a live worker-presence row seeded around it. The row is
 * created BEFORE `body` starts (stage `validating`), advanced through the
 * handle, and marked not-live + torn down in a `finally` so it disappears on
 * EVERY exit path — a landed run, a parked gate, or a thrown error alike.
 * Returns whatever `body` returns (and re-throws whatever it throws, after the
 * teardown has run).
 */
export async function withAdoptPresence<T>(
  io: AdoptPresenceIo,
  params: AdoptPresenceParams,
  body: (handle: AdoptPresenceHandle) => Promise<T>,
): Promise<T> {
  const attemptDir = buildWorkerAttemptPath(
    params.tmpDir,
    REQUEUE_ADOPT_WORKER,
    params.issue,
    REQUEUE_ADOPT_ATTEMPT,
  );
  const statePath = workerStatePath(attemptDir);
  io.seed({
    statePath,
    attemptDir,
    worker: REQUEUE_ADOPT_WORKER,
    issue: params.issue,
    title: params.title,
    runner: params.runner,
    stage: "validating",
  });
  const handle: AdoptPresenceHandle = {
    markStage: (stage) => io.setStage(statePath, stage),
  };
  try {
    return await body(handle);
  } finally {
    await io.teardown(statePath, attemptDir);
  }
}
