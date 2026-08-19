import { SLOT_CIRCUIT_DEFAULTS } from "../slot-circuit.js";
import { resolveWorkerBudgets, type WorkerBudgets } from "../worker-budget.js";

import type { CastleLaneRecord } from "@reddb-io/worker/engine";

// ---------- tunables ----------

/** Supervisor tunables, mirroring the `*_S` / `CIRCUIT_*` / `STALL_*` env knobs
 * read at the top of supervisor.sh. The caller resolves these from env (with
 * the same defaults) so this module stays env-free and deterministic. */
export interface SupervisorConfig {
  /** RED_AFK_TARGET — desired worker count (default 2). */
  target: number;
  /** RED_AFK_FAST_DEATH_S — a worker dying within this many seconds of spawn is
   * a "fast death" (default 30). */
  fastDeathThresholdS: number;
  /** RED_AFK_CIRCUIT_K — fast deaths inside the window that trip the breaker
   * (default 5). */
  circuitK: number;
  /** RED_AFK_CIRCUIT_WINDOW_S — sliding window for the breaker (default 90). */
  circuitWindowS: number;
  /** RED_AFK_STALL_THRESHOLD_S — agent-lane silence that flags a slot stalled
   * (default 600). */
  stallThresholdS: number;
  /** RED_AFK_STALL_KILL_THRESHOLD_S — agent-lane silence past which a stalled
   * slot becomes a hard-reap candidate (default 1800). Must be strictly greater
   * than stallThresholdS — validateStallThresholds enforces it. */
  stallKillThresholdS: number;
  /**
   * RED_AFK_ISSUE_WALL_CLOCK_MAX_S / `afk.issue_wall_clock_max_s` — the
   * activity-independent wall-clock ceiling a single attempt may hold one issue
   * for (default 2700 = 45 min). The age-based twin of stallKillThresholdS:
   * silence-based caps cannot see a busy attempt that never converges, so this
   * one ignores activity entirely and keys off age since claim. Generous by
   * design — it is a runaway backstop, not a pace-setter.
   */
  issueWallClockMaxS: number;
  /** Runner name carried in the discard / no-sentinel envelopes
   * (RED_AFK_RUNNER, default "claude"). */
  runner: string;
  /** Dev bundle version the running supervisor was launched from. */
  bundleVersion?: string;
  /** RED_AFK_POLL_S — seconds the health-check loop sleeps between ticks
   * (default 15, matching supervisor.sh). Prevents the loop from busy-spinning.
   * This is the interval used when NO event lane is wired (`deps.wake` absent) —
   * the unchanged pre-#934 cadence, so a fleet without event-driven supervision
   * behaves exactly as before. */
  pollIntervalS: number;
  /**
   * RED_AFK_WAKE_FALLBACK_S — the safety-net timer interval (seconds, default 60)
   * used ONLY when an event lane (`deps.wake`) is wired (#934). With events
   * driving responsiveness, the loop no longer needs the tight `pollIntervalS`
   * poll to notice a state change promptly, so the idle timer can relax to this
   * longer interval — that is the measurable reduction in idle wake-ups: an idle
   * fleet wakes every `eventFallbackS` instead of every `pollIntervalS`, while a
   * real state change still wakes it immediately. The threshold-based stall
   * detector (600s/1800s) is unaffected by the coarser idle cadence. 0 /
   * non-numeric falls back to the default; values below `pollIntervalS` simply
   * poll more often (harmless).
   */
  eventFallbackS: number;
  /**
   * RED_AFK_TICK_TIMEOUT_S — per-tick wall-clock ceiling (default 120). A single
   * supervise tick should complete in well under a second; if one exceeds this
   * (a gh / ps / git call hung with no timeout), the tick is abandoned and the
   * loop continues to the next pass instead of freezing forever. This is what
   * keeps the supervisor from going alive-but-quiescent — a live PID that stops
   * spawning, never recovers, and emits no signal. 0 / non-numeric falls back to
   * the default so a typo can never disable the guard.
   */
  tickTimeoutS: number;
  /**
   * RED_AFK_SUPERVISOR_STALE_S — the EXTERNAL watchdog's quiescence threshold
   * (default 300). A supervisor whose #406 heartbeat has not advanced within this
   * many seconds is treated as hard-hung (alive PID, drain loop wedged) and
   * recovered by the detached fleet watchdog (with fleet pre-check / opt-in
   * monitor tick as secondary surfaces) — see
   * watchdog.ts + classifySupervisor. This is the recovery half of the
   * unwedgeable-loop work: tickTimeoutS keeps a SINGLE tick from freezing the
   * loop; this knob catches the case where the whole process is hung below the
   * tick boundary (e.g. an un-timed gh call inside the heartbeat emit). Must be
   * strictly greater than tickTimeoutS — validateSupervisorStaleThreshold enforces
   * it at boot so a slow-but-live tick is never misread as quiescent. 0 /
   * non-numeric falls back to the default so a typo can never disable recovery.
   */
  supervisorStaleS: number;
  /**
   * RED_AFK_SUPERVISOR_PROGRESS_STALE_S — forward-progress quiescence threshold
   * (default 900). A supervisor whose ticks keep timing out (abandoned) records no
   * new `lastProgressEpoch` in the heartbeat; if that epoch goes this many seconds
   * stale while slots are occupied the watchdog classifies the supervisor quiescent
   * even though the wall-clock heartbeat epoch is fresh — loop-liveness alone is
   * not enough proof of health. Must be strictly greater than supervisorStaleS
   * (otherwise a stale heartbeat would already fire first). 0 / non-numeric falls
   * back to the default so a typo can never disable the guard.
   */
  progressStaleS: number;
  /** RED_AFK_HALF_OPEN_BASE_S — base cooldown (seconds) for the first half-open
   * probe after a circuit trip (default 60s). */
  halfOpenBaseS: number;
  /** RED_AFK_HALF_OPEN_CAP_S — maximum cooldown cap for exponential backoff
   * (default 3600s = 1 hour). */
  halfOpenCapS: number;
  /**
   * RED_AFK_TRUNK_FRESHNESS_INTERVAL_S — minimum seconds between supervisor
   * refreshes of `origin/<trunk>` into the fleet-owned `red-trunk` mirror
   * (default 60). The first eligible tick refreshes immediately; later ticks
   * inside this window report `throttled` and avoid another remote fetch.
   */
  trunkFreshnessIntervalS: number;
  /**
   * RED_AFK_SUPERVISOR_MAX_RESTARTS — crash-loop bound for the dead-supervisor
   * watchdog (#1097, default 5). When a supervisor is found DEAD (its pid file
   * points to a no-longer-alive process) with a non-empty `ready-for-agent` queue
   * and live workers below target, the detached fleet watchdog respawns the
   * fleet and records the restart epoch. Once this many restarts land
   * inside `supervisorRestartWindowS` the watchdog STOPS respawning and surfaces
   * the crash loop instead of hiding it behind an endless respawn. 0 / non-numeric
   * falls back to the default so a typo can never disable the bound (and never
   * silently turn a bounded safety net into an infinite respawn loop).
   */
  supervisorMaxRestarts: number;
  /**
   * RED_AFK_SUPERVISOR_RESTART_WINDOW_S — sliding window (seconds, default 300)
   * for the dead-supervisor restart bound above. Restart epochs older than this
   * are pruned before the count is compared to `supervisorMaxRestarts`, so a slow
   * trickle of unrelated respawns never trips the crash-loop guard. 0 / non-numeric
   * falls back to the default.
   */
  supervisorRestartWindowS: number;
  /**
   * Per-drain USD budget. Undefined means today's behaviour: no budget ladder,
   * no spawn downgrade, and no hard stop. Spend is read from the WorkerVitals
   * lane (`current.cost_usd`) through SupervisorFs.fleetCostUsd.
   */
  drainBudgetUsd?: number;
  /** RED_AFK_REAP_CONTEST_WINDOW_S — seconds a stall-reaped retry waits for the
   * original attempt branch to advance before rotating the issue back to
   * ready-for-agent. */
  reapContestWindowS: number;
  /** RED_AFK_SHRINK_MODE — runtime fleet shrink behavior. */
  shrinkMode: ElasticShrinkMode;
  /**
   * Per-worker resource ceilings (ADR 0128 §8). An ABSENT budget is unlimited,
   * never zero — the default table sets only `wall_clock_s` (from the per-issue
   * ceiling), so a repo that configures nothing enforces exactly today's
   * behaviour and pays no extra sampling.
   */
  workerBudgets: WorkerBudgets;
}

export const SUPERVISOR_DEFAULTS = {
  target: 2,
  fastDeathThresholdS: 30,
  circuitK: 5,
  circuitWindowS: 90,
  stallThresholdS: 600,
  stallKillThresholdS: 1800,
  issueWallClockMaxS: 2700,
  runner: "claude",
  pollIntervalS: 15,
  eventFallbackS: 60,
  tickTimeoutS: 120,
  supervisorStaleS: 300,
  progressStaleS: 900,
  halfOpenBaseS: SLOT_CIRCUIT_DEFAULTS.halfOpenBaseS,
  halfOpenCapS: SLOT_CIRCUIT_DEFAULTS.halfOpenCapS,
  trunkFreshnessIntervalS: 60,
  supervisorMaxRestarts: 5,
  supervisorRestartWindowS: 300,
  reapContestWindowS: 30,
  shrinkMode: "drain-then-retire",
  // Empty = every per-worker budget unlimited. The real table is resolved in
  // resolveSupervisorConfig, which folds the per-issue wall-clock ceiling in.
  workerBudgets: {},
} as const satisfies SupervisorConfig;

export type ElasticShrinkMode = "hard-kill" | "drain-then-retire";

export interface ElasticResizeRequest {
  target: number;
  shrinkMode?: ElasticShrinkMode;
  runner?: string;
}

export type DrainBudgetTier = "OK" | "WARNING" | "CRITICAL" | "HARD_STOP";

export interface DrainBudgetStatus {
  tier: DrainBudgetTier;
  spentUsd: number;
  limitUsd: number;
  percent: number;
}

export interface ValidationAdmissionInput {
  knownHeavy: boolean;
  availableMemoryMb?: number;
  minAvailableMemoryMb?: number;
  activeHeavyValidations?: number;
}

export interface ValidationAdmissionDecision {
  admit: boolean;
  reason: "not-heavy" | "admit" | "serialize-heavy-validation" | "insufficient-memory";
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseShrinkMode(raw: string | undefined): ElasticShrinkMode | undefined {
  if (raw === "hard-kill" || raw === "drain-then-retire") return raw;
  return undefined;
}

export type SupervisorConfigReader = (key: string) => string;

export function evaluateDrainBudget(
  spentUsd: number,
  limitUsd: number | undefined,
): DrainBudgetStatus | undefined {
  if (limitUsd === undefined || limitUsd <= 0) return undefined;
  const spent = Math.max(0, spentUsd);
  const percent = spent / limitUsd;
  const tier: DrainBudgetTier =
    percent >= 1 ? "HARD_STOP" :
    percent >= 0.9 ? "CRITICAL" :
    percent >= 0.75 ? "WARNING" :
    "OK";
  return { tier, spentUsd: spent, limitUsd, percent };
}

/**
 * Resource-aware validation admission (#1758). Heavy suites are serialized by
 * default, and may also be held until the host reports enough available memory.
 * This is intentionally pure so fleet/runtime adapters can feed it ps/free
 * samples without coupling command execution to the scheduler.
 */
export function evaluateValidationAdmission(
  input: ValidationAdmissionInput,
): ValidationAdmissionDecision {
  if (!input.knownHeavy) return { admit: true, reason: "not-heavy" };
  if ((input.activeHeavyValidations ?? 0) > 0) {
    return { admit: false, reason: "serialize-heavy-validation" };
  }
  const min = input.minAvailableMemoryMb;
  if (min !== undefined && min > 0 && (input.availableMemoryMb ?? 0) < min) {
    return { admit: false, reason: "insufficient-memory" };
  }
  return { admit: true, reason: "admit" };
}

/**
 * Resolve a SupervisorConfig from an env bag, mirroring the `${VAR:-default}`
 * ladder at the top of supervisor.sh. Non-numeric overrides fall back to the
 * default (parity with bash arithmetic on an unset/garbage value collapsing to
 * the literal default expansion). Defaults to process.env.
 */
export function resolveSupervisorConfig(
  env: Record<string, string | undefined> = process.env,
  getCfg: SupervisorConfigReader = () => "",
): SupervisorConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw !== undefined && /^[0-9]+$/.test(raw)) return Number(raw);
    return fallback;
  };
  const issueWallClockMaxS =
    num("RED_AFK_ISSUE_WALL_CLOCK_MAX_S", 0) ||
    parsePositiveNumber(getCfg("afk.issue_wall_clock_max_s")) ||
    SUPERVISOR_DEFAULTS.issueWallClockMaxS;
  return {
    target: num("RED_AFK_TARGET", SUPERVISOR_DEFAULTS.target),
    fastDeathThresholdS: num("RED_AFK_FAST_DEATH_S", SUPERVISOR_DEFAULTS.fastDeathThresholdS),
    circuitK: num("RED_AFK_CIRCUIT_K", SUPERVISOR_DEFAULTS.circuitK),
    circuitWindowS: num("RED_AFK_CIRCUIT_WINDOW_S", SUPERVISOR_DEFAULTS.circuitWindowS),
    stallThresholdS: num("RED_AFK_STALL_THRESHOLD_S", SUPERVISOR_DEFAULTS.stallThresholdS),
    stallKillThresholdS: num(
      "RED_AFK_STALL_KILL_THRESHOLD_S",
      SUPERVISOR_DEFAULTS.stallKillThresholdS,
    ),
    // 0 would reap every attempt the moment it claims — floor it back to the
    // default so a typo can never turn the backstop into an instant killer.
    issueWallClockMaxS,
    runner: env.RED_AFK_RUNNER && env.RED_AFK_RUNNER.length > 0 ? env.RED_AFK_RUNNER : SUPERVISOR_DEFAULTS.runner,
    pollIntervalS: num("RED_AFK_POLL_S", SUPERVISOR_DEFAULTS.pollIntervalS),
    // 0 would make the safety-net fire instantly (busy-spin) — floor it back to
    // the default so a typo can never disable the relaxed idle cadence.
    eventFallbackS:
      num("RED_AFK_WAKE_FALLBACK_S", SUPERVISOR_DEFAULTS.eventFallbackS) ||
      SUPERVISOR_DEFAULTS.eventFallbackS,
    // 0 is a valid /^[0-9]+$/ match but would abandon every tick instantly, so
    // floor it back to the default — the guard can never be silently disabled.
    tickTimeoutS:
      num("RED_AFK_TICK_TIMEOUT_S", SUPERVISOR_DEFAULTS.tickTimeoutS) || SUPERVISOR_DEFAULTS.tickTimeoutS,
    // 0 would make every live supervisor look quiescent — floor it back to the
    // default so the watchdog can never be silently disabled by a typo.
    supervisorStaleS:
      num("RED_AFK_SUPERVISOR_STALE_S", SUPERVISOR_DEFAULTS.supervisorStaleS) ||
      SUPERVISOR_DEFAULTS.supervisorStaleS,
    // 0 would fire the progress check instantly — floor back to the default.
    progressStaleS:
      num("RED_AFK_SUPERVISOR_PROGRESS_STALE_S", SUPERVISOR_DEFAULTS.progressStaleS) ||
      SUPERVISOR_DEFAULTS.progressStaleS,
    halfOpenBaseS: num("RED_AFK_HALF_OPEN_BASE_S", SUPERVISOR_DEFAULTS.halfOpenBaseS),
    halfOpenCapS: num("RED_AFK_HALF_OPEN_CAP_S", SUPERVISOR_DEFAULTS.halfOpenCapS),
    trunkFreshnessIntervalS:
      num("RED_AFK_TRUNK_FRESHNESS_INTERVAL_S", SUPERVISOR_DEFAULTS.trunkFreshnessIntervalS) ||
      parsePositiveNumber(getCfg("afk.trunk_freshness_interval_s")) ||
      SUPERVISOR_DEFAULTS.trunkFreshnessIntervalS,
    // 0 would disable the crash-loop bound (endless respawns) — floor back to the
    // default so a typo can never turn the safety net into an infinite loop.
    supervisorMaxRestarts:
      num("RED_AFK_SUPERVISOR_MAX_RESTARTS", SUPERVISOR_DEFAULTS.supervisorMaxRestarts) ||
      SUPERVISOR_DEFAULTS.supervisorMaxRestarts,
    // 0 would prune every restart epoch instantly (bound never trips) — floor back.
    supervisorRestartWindowS:
      num("RED_AFK_SUPERVISOR_RESTART_WINDOW_S", SUPERVISOR_DEFAULTS.supervisorRestartWindowS) ||
      SUPERVISOR_DEFAULTS.supervisorRestartWindowS,
    drainBudgetUsd:
      parsePositiveNumber(env.RED_AFK_DRAIN_MAX_COST_USD) ??
      parsePositiveNumber(getCfg("afk.drain.max_cost_usd")),
    reapContestWindowS: num("RED_AFK_REAP_CONTEST_WINDOW_S", SUPERVISOR_DEFAULTS.reapContestWindowS),
    shrinkMode:
      parseShrinkMode(env.RED_AFK_SHRINK_MODE) ??
      parseShrinkMode(getCfg("afk.shrink_mode")) ??
      SUPERVISOR_DEFAULTS.shrinkMode,
    // The wall-clock budget IS the per-issue ceiling above — the budget table
    // reports the ceiling that is actually enforced instead of minting a second
    // one. Memory and cost default to `unlimited` (ADR 0128 §8), so an
    // unconfigured repo pays no per-tick sampling.
    workerBudgets: resolveWorkerBudgets({ env, getCfg, wallClockS: issueWallClockMaxS }),
  };
}

/**
 * validateStallThresholds — boot-time invariant from supervisor.sh:142. The
 * hard-reap threshold must be strictly greater than the stall threshold; a
 * worker can never become a reap candidate before it is even flagged stalled.
 * Throws (the supervisor `exit $?`s on failure) when the invariant is violated.
 * Mirrors `validate_stall_thresholds`.
 */
export function validateStallThresholds(config: Pick<SupervisorConfig, "stallThresholdS" | "stallKillThresholdS">): void {
  if (config.stallKillThresholdS <= config.stallThresholdS) {
    throw new Error(
      `RED_AFK_STALL_KILL_THRESHOLD_S (${config.stallKillThresholdS}) must be > RED_AFK_STALL_THRESHOLD_S (${config.stallThresholdS})`,
    );
  }
}

/**
 * validateSupervisorStaleThreshold — boot-time invariant for the external
 * watchdog (#407). The quiescence threshold must be strictly greater than the
 * per-tick wall-clock ceiling; otherwise a tick that legitimately runs up to
 * `tickTimeoutS` (a slow-but-live gh/ps/git call) followed by the next poll
 * could be misread as a hung loop and a healthy supervisor needlessly killed.
 * Throws (the supervisor `exit $?`s on a bad config) when violated.
 */
export function validateSupervisorStaleThreshold(
  config: Pick<SupervisorConfig, "supervisorStaleS" | "tickTimeoutS">,
): void {
  if (config.supervisorStaleS <= config.tickTimeoutS) {
    throw new Error(
      `RED_AFK_SUPERVISOR_STALE_S (${config.supervisorStaleS}) must be > RED_AFK_TICK_TIMEOUT_S (${config.tickTimeoutS})`,
    );
  }
}

/**
 * validateSupervisorProgressThreshold — boot-time invariant for the forward-
 * progress quiescence check (#579). The progress staleness threshold must be
 * strictly greater than the heartbeat staleness threshold; otherwise the
 * heartbeat check would always fire first and the progress check would never
 * be reached. Throws when violated.
 */
export function validateSupervisorProgressThreshold(
  config: Pick<SupervisorConfig, "progressStaleS" | "supervisorStaleS">,
): void {
  if (config.progressStaleS <= config.supervisorStaleS) {
    throw new Error(
      `RED_AFK_SUPERVISOR_PROGRESS_STALE_S (${config.progressStaleS}) must be > RED_AFK_SUPERVISOR_STALE_S (${config.supervisorStaleS})`,
    );
  }
}
