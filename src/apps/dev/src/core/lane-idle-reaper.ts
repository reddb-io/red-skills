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
//   - the fleet stall DETECTOR  — `computeStalled` (supervisor.ts): worker alive
//     ≥ soft threshold AND agent lane silent ≥ soft threshold;
//   - the reaper-signal PREDICATE — `deriveSnapshot` + `decideReaperSignal`
//     (reaper-signal.ts): the irreversible kill is gated on no active build/test
//     descendant AND flat cpu.
// This is exactly the composition `pollStallDetector` performs for the fleet,
// re-shaped as a continuous side-channel poller for the solo path. It does NOT
// duplicate or re-implement the #400 progress guard — that watches commits; this
// watches the agent lane.
//
// SIGNAL HYGIENE (#243): the liveness signal is the active attempt's agent lane
// JSONL mtime — never `afk.log` or the firehose `log.jsonl`, which the per-minute
// heartbeat keeps fresh and would mask a real stall. The caller wires
// `laneMtime` to stat the attempt's `agent.log.jsonl`.
//
// The reaper runs in a SIDE-CHANNEL (an injected periodic scheduler) independent
// of the inner-agent stream, so a fully-hung runner is still observed and reaped.
// On a kill verdict it calls `abort` once — wired by the caller to the sandcastle
// run's AbortSignal, which SIGTERMs the inner pipeline tree then SIGKILLs after
// the grace, the same tree-wide teardown the fleet reaper performs. The aborted
// run then flows through the existing no-sentinel terminal policy (envelope +
// label rotation + worktree teardown).

import { computeStalled, SUPERVISOR_DEFAULTS, validateStallThresholds } from "./supervisor.js";
import { decideReaperSignal, deriveSnapshot, type ProcessSnapshotEntry } from "./reaper-signal.js";

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
  return { stallThresholdS, stallKillThresholdS, stallPollS };
}

/** The kill verdict the reaper reports each tick: "not-candidate" (not yet
 * stalled per the fleet detector), "no-kill" (stalled but inside the grace window
 * or busy per the reaper-signal predicate), or "kill" (reaped this tick). */
export type LaneIdleVerdict = "not-candidate" | "no-kill" | "kill";

/** One poll's observation, surfaced via `onTick` for diagnostics. */
export interface LaneIdleInfo {
  /** Agent-lane mtime observed this tick (epoch seconds; 0 when absent). */
  laneMtime: number;
  /** Agent-lane idle duration this tick (seconds; 0 when the lane is unseen). */
  idleSeconds: number;
  /** True when the fleet detector flags the worker stalled (alive ≥ soft AND
   * lane silent ≥ soft). */
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
  /** Agent-lane mtime probe (epoch seconds; 0 when the lane does not exist yet).
   * MUST read the clean agent lane (`agent.log.jsonl`), never afk.log / the
   * firehose (#243). */
  laneMtime: () => number;
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
 * so it is fully unit-testable against fixed inputs, mirroring `startAttemptGuard`.
 */
export function startLaneIdleReaper(opts: LaneIdleReaperOptions): {
  stop: () => void;
  firedReap: () => boolean;
} {
  let fired = false;
  const cancel = opts.schedule(() => {
    if (fired) return;
    const now = opts.now();
    const laneMtime = opts.laneMtime();
    const stalled = computeStalled(opts.spawnEpoch, laneMtime, now, opts.stallThresholdS);
    let verdict: LaneIdleVerdict = "not-candidate";
    if (stalled) {
      // The lane mtime IS the stall anchor, so idle === now - lastLaneActivity —
      // exactly the fleet's `now - stallSinceEpoch`.
      const idle = now - laneMtime;
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
    const idleSeconds = laneMtime > 0 ? now - laneMtime : 0;
    opts.onTick?.({ laneMtime, idleSeconds, stalled, verdict, nowS: now });
  }, opts.intervalMs);
  return { stop: cancel, firedReap: () => fired };
}
