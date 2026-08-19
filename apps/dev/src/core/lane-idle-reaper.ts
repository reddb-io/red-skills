// lane-idle-reaper — the solo `run` worker's lane-idle stall reaper (issue #363).
//
// Fleet Mode (the supervisor) has had a passive stall detector + hard stall
// reaper for a while; a SOLO `/afk run` worker had no equivalent. The fatal
// "hang forever" case is already removed by the in-process attempt PROGRESS
// guard (#400, commit-anchored — aborts at the attempt-timeout cap, solo and
// fleet). This module is the COMPLEMENTARY faster layer: cut an idle hang at the
// stall threshold (minutes) rather than only at the progress cap, with the same
// busy-predicate so a mid-build/test worker is never killed.
//
// It is NOT a second mechanism. It REUSES the fleet machinery:
//   - the fleet stall DETECTOR  — the red-castle `evaluateLiveness` evaluator
//     (ADR 0083 §3): lane silent ≥ soft threshold AND (if armed) no live
//     descendants → stalled. The verdict is injected via `livenessVerdict` so
//     the reaper is fully testable without a real process tree or lane file.
//   - the reaper-signal PREDICATE — `deriveSnapshot` + `decideReaperSignal`
//     (reaper-signal.ts): the irreversible kill is gated on no active build/test
//     descendant AND flat cpu.
// This is exactly the composition `pollStallDetector` performs for the fleet,
// re-shaped as a continuous side-channel poller for the solo path. It does NOT
// duplicate or re-implement the #400 progress guard — that watches commits; this
// watches the agent lane.
//
// SIGNAL HYGIENE (#243 / #1022): the liveness signal is the red-castle
// `evaluateLiveness` evaluator over the attempt's `liveness.lane.jsonl` —
// never `afk.log` or the firehose `agent.log.toonl`, which the per-minute
// heartbeat keeps fresh and would mask a real stall. The caller wires
// `livenessVerdict` to a sync probe that reads the liveness lane and calls
// the evaluator (runtime/wire.ts `agentLivenessVerdictSync`).
//
// The reaper runs in a SIDE-CHANNEL (an injected periodic scheduler) independent
// of the inner-agent stream, so a fully-hung runner is still observed and reaped.
// On a kill verdict it calls `abort` once — wired by the caller to the sandcastle
// run's AbortSignal, which SIGTERMs the inner pipeline tree then SIGKILLs after
// the grace, the same tree-wide teardown the fleet reaper performs. The aborted
// run then flows through the existing no-sentinel terminal policy (envelope +
// label rotation + worktree teardown).

import { SUPERVISOR_DEFAULTS, validateStallThresholds } from "./supervisor.js";
import { decideReaperSignal, deriveSnapshot, type ProcessSnapshotEntry } from "./reaper-signal.js";
import type { LivenessVerdict } from "@reddb-io/worker";

/** Default agent-lane sampling cadence in seconds (RED_AFK_STALL_POLL_S). Mirrors
 * the fleet passive stall detector's poll cadence so the solo reaper observes a
 * stall on the same schedule the supervisor would. */
export const DEFAULT_STALL_POLL_S = 30;

/** The resolved solo-path stall thresholds + poll cadence. */
export interface LaneIdleStallConfig {
  /** RED_AFK_STALL_THRESHOLD_S — soft stall threshold (seconds). */
  stallThresholdS: number;
  /** RED_AFK_STALL_KILL_THRESHOLD_S — hard-reap threshold (seconds). */
  stallKillThresholdS: number;
  /** RED_AFK_STALL_POLL_S — agent-lane sampling cadence (seconds). */
  stallPollS: number;
  /** RED_AFK_ISSUE_WALL_CLOCK_MAX_S — activity-independent per-issue wall-clock
   * ceiling (seconds, #2286). Mirrors the fleet knob so solo and fleet agree. */
  issueWallClockMaxS: number;
}

/**
 * Resolve the solo lane-idle reaper's stall knobs from an env bag, mirroring the
 * `${VAR:-default}` ladder and `/^[0-9]+$/` typo-safety of `resolveSupervisorConfig`,
 * and reusing the fleet defaults (600 / 1800) so the env vars stay CONSISTENT
 * across solo and fleet. Validates the invariant the supervisor enforces at boot
 * (`validateStallThresholds`): the kill threshold MUST be strictly greater than
 * the soft threshold — a `<=` config FAILS FAST here (throws) so the solo run can
 * never arm a reaper that would reap before it even flags stalled. A non-positive
 * / non-numeric poll value floors back to {@link DEFAULT_STALL_POLL_S} so a typo
 * can never busy-spin or disable the poll.
 */
export function resolveLaneIdleStallConfig(
  env: Record<string, string | undefined> = process.env,
): LaneIdleStallConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw !== undefined && /^[0-9]+$/.test(raw)) return Number(raw);
    return fallback;
  };
  const stallThresholdS = num("RED_AFK_STALL_THRESHOLD_S", SUPERVISOR_DEFAULTS.stallThresholdS);
  const stallKillThresholdS = num("RED_AFK_STALL_KILL_THRESHOLD_S", SUPERVISOR_DEFAULTS.stallKillThresholdS);
  // Boot invariant (parity with the supervisor): kill > soft, or fail fast.
  validateStallThresholds({ stallThresholdS, stallKillThresholdS });
  // 0 matches /^[0-9]+$/ but would busy-spin, so floor it back to the default.
  const stallPollS = num("RED_AFK_STALL_POLL_S", DEFAULT_STALL_POLL_S) || DEFAULT_STALL_POLL_S;
  // 0 would reap every attempt the moment it claims — floor back to the default.
  const issueWallClockMaxS =
    num("RED_AFK_ISSUE_WALL_CLOCK_MAX_S", SUPERVISOR_DEFAULTS.issueWallClockMaxS) ||
    SUPERVISOR_DEFAULTS.issueWallClockMaxS;
  return { stallThresholdS, stallKillThresholdS, stallPollS, issueWallClockMaxS };
}

/** The kill verdict the reaper reports each tick: "not-candidate" (not yet
 * stalled per the fleet detector), "no-kill" (stalled but inside the grace window
 * or busy per the reaper-signal predicate), or "kill" (reaped this tick). */
export type LaneIdleVerdict = "not-candidate" | "no-kill" | "kill";

/** One poll's observation, surfaced via `onTick` for diagnostics. */
export interface LaneIdleInfo {
  /** Agent-lane idle duration this tick (seconds; 0 when the lane is unseen or
   * laneAgeMs is unavailable from the verdict). */
  idleSeconds: number;
  /** True when the evaluator verdict is "stalled" (lane idle ≥ soft threshold
   * AND cross-check confirms no live descendants). */
  stalled: boolean;
  /** The kill verdict this tick. */
  verdict: LaneIdleVerdict;
  /** The reaper's clock (epoch seconds) at this tick. */
  nowS: number;
}

export interface LaneIdleReaperOptions {
  /** Epoch seconds the inner-agent run started — the "worker alive" anchor the
   * fleet detector (`computeStalled`) gates on, so a freshly-spawned worker is
   * never a candidate before the soft threshold elapses. */
  spawnEpoch: number;
  /** RED_AFK_STALL_THRESHOLD_S — agent-lane silence (and minimum worker age)
   * that flags the worker stalled. */
  stallThresholdS: number;
  /** RED_AFK_STALL_KILL_THRESHOLD_S — agent-lane silence past which a stalled
   * worker becomes a hard-reap candidate. Must be strictly greater than
   * stallThresholdS (validated at boot via validateStallThresholds). */
  stallKillThresholdS: number;
  /** Poll cadence in milliseconds (RED_AFK_STALL_POLL_S × 1000). */
  intervalMs: number;
  /**
   * Red-castle liveness evaluator verdict probe (ADR 0083 §3). Returns the
   * combined lane-recency + process-cross-check verdict, or null when the
   * attempt dir cannot be resolved (worker between iterations). A null or
   * non-stalled verdict keeps the worker as a non-candidate this tick.
   */
  livenessVerdict: () => LivenessVerdict | null;
  /** Inner-agent process-tree snapshot, reduced by `deriveSnapshot` into the
   * busy signals. Consulted only at the kill escalation so `ps` is not run every
   * poll. A safe-by-default inspector reports a busy snapshot on inspection
   * failure (runtime/proc-tree.ts), so a flaky `ps` can never authorise a kill. */
  inspectTree: () => readonly ProcessSnapshotEntry[];
  /** Reaper clock (epoch seconds), injected for determinism. */
  now: () => number;
  /** Periodic scheduler — runs `fn` every `ms`, returns a cancel function.
   * Injected so tests pump ticks with no real timers. */
  schedule: (fn: () => void, ms: number) => () => void;
  /** Fired once, on the first kill verdict. Wired by the caller to the
   * sandcastle run's AbortController so the inner tree is torn down. */
  abort: () => void;
  /** Optional per-poll diagnostic sink. Never throws (the caller wraps its IO). */
  onTick?: (info: LaneIdleInfo) => void;
}

/**
 * Arm the lane-idle stall reaper. Polls the agent-lane mtime every `intervalMs`;
 * on each tick it runs the fleet stall detector (`computeStalled`) and, once a
 * stalled worker has been silent past the kill threshold, gates the irreversible
 * kill behind the reaper-signal predicate (`deriveSnapshot` + `decideReaperSignal`)
 * — firing `abort` exactly once iff the worker is genuinely stuck (idle past the
 * threshold AND no active build/test descendant AND flat cpu). A busy worker
 * (active descendant or non-trivial cpu) is left alone.
 *
 * Pure over its injected clock / scheduler / probes — no real timers, fs, or ps —
 * so it is fully unit-testable against fixed inputs.
 */
export function startLaneIdleReaper(opts: LaneIdleReaperOptions): {
  stop: () => void;
  firedReap: () => boolean;
} {
  let fired = false;
  const cancel = opts.schedule(() => {
    if (fired) return;
    const now = opts.now();

    // Startup window: skip freshly-spawned workers (same guard as the fleet's
    // pollStallDetector to prevent reaping a worker before it can write its lane).
    const workerAgeS = now - opts.spawnEpoch;
    if (!(opts.spawnEpoch > 0) || !(workerAgeS >= opts.stallThresholdS)) {
      opts.onTick?.({ idleSeconds: 0, stalled: false, verdict: "not-candidate", nowS: now });
      return;
    }

    // The red-castle evaluator (ADR 0083 §3) combines lane recency and process
    // cross-check into a single verdict. A null probe result means the worker is
    // between iterations — not a candidate.
    const lv = opts.livenessVerdict();
    // `capped` (#2701) is the wall-clock ceiling firing on an attempt that is
    // still working — a different verdict, but the same solo escalation: the run
    // must still be aborted, or the ceiling would only bind in fleet mode.
    const stalled = lv !== null && (lv.status === "stalled" || lv.status === "capped");

    // Lane idle duration from the evaluator's laneAgeMs (ms → s). When
    // laneAgeMs is absent (lane never written), fall back to worker age so a
    // stalled-but-never-written worker still escalates past the kill threshold.
    const idleSeconds = lv?.laneAgeMs !== undefined ? Math.round(lv.laneAgeMs / 1000) : 0;

    let verdict: LaneIdleVerdict = "not-candidate";
    if (stalled) {
      const idle = idleSeconds > 0 ? idleSeconds : workerAgeS;
      if (idle >= opts.stallKillThresholdS) {
        const snapshot = deriveSnapshot(opts.inspectTree());
        const decision = decideReaperSignal({
          idleSeconds: idle,
          idleThresholdSeconds: opts.stallKillThresholdS,
          activeDescendant: snapshot.activeDescendant,
          cpuPct: snapshot.cpuPct,
        });
        verdict = decision === "kill" ? "kill" : "no-kill";
        if (decision === "kill") {
          fired = true;
          opts.abort();
        }
      } else {
        // Stalled but inside the grace window between soft and kill thresholds.
        verdict = "no-kill";
      }
    }
    opts.onTick?.({ idleSeconds, stalled, verdict, nowS: now });
  }, opts.intervalMs);
  return { stop: cancel, firedReap: () => fired };
}
