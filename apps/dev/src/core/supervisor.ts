// supervisor — the AFK fleet supervisor's DECISION + sequencing layer, ported
// from supervisor.sh's health-check main loop (lines ~1113-1141) and the
// functions it drives: validate_stall_thresholds (~142), the circuit breaker
// (handle_dead_slot ~994), poll_stall_detector (~611) + reap_stalled_slot
// (~868), and sweep_parked_slot (~767). The SKILL.md "Fleet Mode", "Circuit
// Trip Sweep", and stall-reaper paragraphs are the prose parity target.
//
// This module is PURE SEQUENCING over injected IO, mirroring boot.ts: every
// long-running side effect (spawning a worker, killing a tree, reading a clock,
// touching the filesystem, calling gh) is injected through `deps`. The decision
// logic — circuit-breaker trip, stall candidacy, the reaper-signal kill gate —
// lives here as pure functions; the reaper-signal predicate itself is COMPOSED
// from reaper-signal.ts and never re-implemented. No real process, fs, or gh
// call lives in this file. The supervisor only manages worker lifecycle; the
// workers own all claim-lock / state / queue semantics (supervisor.sh header).

import { decideReaperSignal, deriveSnapshot, type ProcessSnapshotEntry } from "./reaper-signal.js";
import { buildEnvelope } from "./envelope.js";
import { blockedLabelFor } from "./attempt-outcome.js";
import { recoveryCap, recoveryDecision, type RecoveryEnv } from "./recovery.js";
import {
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_HUMAN,
  LABEL_RUNNER_ERROR,
} from "./triage-labels.js";
import {
  computeHalfOpenBackoff,
  isHalfOpenDue,
  SLOT_CIRCUIT_DEFAULTS,
} from "./slot-circuit.js";

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
  /** Runner name carried in the discard / no-sentinel envelopes
   * (RED_AFK_RUNNER, default "claude"). */
  runner: string;
  /** RED_AFK_POLL_S — seconds the health-check loop sleeps between ticks
   * (default 15, matching supervisor.sh). Prevents the loop from busy-spinning. */
  pollIntervalS: number;
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
   * recovered by an already-alive surface (fleet pre-check / monitor tick) — see
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
}

export const SUPERVISOR_DEFAULTS = {
  target: 2,
  fastDeathThresholdS: 30,
  circuitK: 5,
  circuitWindowS: 90,
  stallThresholdS: 600,
  stallKillThresholdS: 1800,
  runner: "claude",
  pollIntervalS: 15,
  tickTimeoutS: 120,
  supervisorStaleS: 300,
  progressStaleS: 900,
  halfOpenBaseS: SLOT_CIRCUIT_DEFAULTS.halfOpenBaseS,
  halfOpenCapS: SLOT_CIRCUIT_DEFAULTS.halfOpenCapS,
} as const satisfies SupervisorConfig;

/**
 * Resolve a SupervisorConfig from an env bag, mirroring the `${VAR:-default}`
 * ladder at the top of supervisor.sh. Non-numeric overrides fall back to the
 * default (parity with bash arithmetic on an unset/garbage value collapsing to
 * the literal default expansion). Defaults to process.env.
 */
export function resolveSupervisorConfig(
  env: Record<string, string | undefined> = process.env,
): SupervisorConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw !== undefined && /^[0-9]+$/.test(raw)) return Number(raw);
    return fallback;
  };
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
    runner: env.RED_AFK_RUNNER && env.RED_AFK_RUNNER.length > 0 ? env.RED_AFK_RUNNER : SUPERVISOR_DEFAULTS.runner,
    pollIntervalS: num("RED_AFK_POLL_S", SUPERVISOR_DEFAULTS.pollIntervalS),
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

// ---------- quiescence detection (pure) ----------

/**
 * A point-in-time read of the fleet supervisor's liveness, gathered by an
 * already-alive surface (fleet pre-check / monitor tick) from the pid file + the
 * #406 heartbeat state file. Pure input to {@link classifySupervisor}.
 */
export interface SupervisorLiveness {
  /** The supervisor pid from afk-supervisor.pid, or null when no pid file. */
  pid: number | null;
  /** Whether that pid is alive (kill -0). Meaningless when pid is null. */
  pidAlive: boolean;
  /** Epoch seconds of the last #406 heartbeat, or null when none was observed. */
  lastHeartbeatEpoch: number | null;
  /**
   * Epoch seconds of the last NON-ABANDONED tick (#579). A tick that timed out
   * (guardedTick returned continueResult) does NOT advance this epoch. When null
   * the supervisor has not completed any tick yet — treated as healthy (can't
   * prove a wedge on a freshly-launched fleet).
   */
  lastProgressEpoch: number | null;
  /** Number of slots currently occupied by a live worker process, from the state
   * file. Used by the progress-stale check: a supervisor with no busy slots is
   * idle (not stuck), so progress staleness alone cannot prove a wedge. */
  slotsBusy: number;
}

/**
 * The watchdog's verdict on a supervisor:
 *   - "absent"    — no live supervisor (no pid / dead pid): nothing to recover;
 *                   a launch may proceed, a monitor tick stays quiet.
 *   - "healthy"   — a live PID whose heartbeat is fresh (or not yet observed, so
 *                   it cannot be PROVEN wedged): leave it alone.
 *   - "quiescent" — a live PID whose heartbeat is stale past the threshold: the
 *                   drain loop is hard-hung and must be recovered.
 */
export type SupervisorHealth = "absent" | "healthy" | "quiescent";

/**
 * classifySupervisor — the pure quiescence detector (#407, #579). Two checks:
 *
 *  1. Heartbeat stale (original #407 check): the wall-clock heartbeat epoch has
 *     not advanced in `staleS` seconds → the supervisor process itself is hard-hung
 *     (below the tick boundary, e.g. a stuck gh call that guardedTick cannot race).
 *
 *  2. Progress stale (#579): the heartbeat IS fresh but every recent tick was
 *     abandoned (timed out / threw), so no `lastProgressEpoch` has been recorded
 *     for `progressStaleS` seconds while slots are occupied. The supervisor is
 *     looping but not completing its supervisory work — treated as quiescent.
 *
 * A missing epoch (null) means the supervisor is freshly launched and has not
 * completed a tick yet — never enough to prove a wedge. Clock skew (a future-
 * stamped epoch) yields a negative age < threshold → healthy.
 */
export function classifySupervisor(
  liveness: SupervisorLiveness,
  now: number,
  staleS: number,
  progressStaleS: number,
): SupervisorHealth {
  if (liveness.pid === null || !liveness.pidAlive) return "absent";
  if (liveness.lastHeartbeatEpoch === null) return "healthy";
  // Check 1: wall-clock heartbeat stale → hard-hung process.
  if (now - liveness.lastHeartbeatEpoch >= staleS) return "quiescent";
  // Check 2: progress stale with occupied slots → loop spinning on abandoned ticks.
  if (
    liveness.lastProgressEpoch !== null &&
    now - liveness.lastProgressEpoch >= progressStaleS &&
    liveness.slotsBusy > 0
  ) {
    return "quiescent";
  }
  return "healthy";
}

// ---------- circuit breaker (pure) ----------

/**
 * The circuit-breaker decision for one slot after a worker death, mirroring the
 * fast-death-ring logic in handle_dead_slot (supervisor.sh ~1012-1031). Pure:
 * given the timestamped death events already recorded for the slot, the new
 * death epoch, and the breaker tunables, it prunes the ring to the window and
 * decides respawn vs trip-and-park.
 */
export interface CircuitDecision {
  /** Death epochs still inside the window after pruning (the new ring). */
  deaths: number[];
  /** Fast-death count after recording this death (deaths.length). */
  count: number;
  /** True when the worker died within fastDeathThresholdS of spawn. */
  fastDeath: boolean;
  /** True when count reached circuitK inside the window → slot parks. */
  trip: boolean;
}

/**
 * Record one worker death against a slot's fast-death ring and decide whether
 * the circuit trips. `priorDeaths` is the slot's ring before this death;
 * `spawnEpoch` and `deathEpoch` bound the worker's lifetime; the tunables are
 * the breaker window/threshold/K.
 *
 * Parity with handle_dead_slot:
 *   - A death is "fast" only when spawnEpoch > 0 AND lifetime < fastDeathThresholdS.
 *   - A slow death does NOT touch the ring (the bash branch is gated on the fast
 *     condition) and never trips — the slot respawns.
 *   - On a fast death the ring is the prior ring + this death, pruned to
 *     entries within circuitWindowS of deathEpoch, and the trip fires when the
 *     pruned count >= circuitK.
 */
export function recordDeath(
  priorDeaths: readonly number[],
  spawnEpoch: number,
  deathEpoch: number,
  config: Pick<SupervisorConfig, "fastDeathThresholdS" | "circuitWindowS" | "circuitK">,
): CircuitDecision {
  const lifetime = deathEpoch - spawnEpoch;
  const fastDeath = spawnEpoch > 0 && lifetime < config.fastDeathThresholdS;
  if (!fastDeath) {
    // Slow death: ring untouched, slot respawns (no prune, no trip).
    return { deaths: [...priorDeaths], count: priorDeaths.length, fastDeath: false, trip: false };
  }
  const pruned = [...priorDeaths, deathEpoch].filter(
    (t) => deathEpoch - t <= config.circuitWindowS,
  );
  const count = pruned.length;
  return { deaths: pruned, count, fastDeath: true, trip: count >= config.circuitK };
}

// ---------- stall candidacy (pure) ----------

/**
 * compute_stalled (supervisor.sh ~551): pure predicate deciding whether a slot
 * meets every passive-stall criterion. The slot is stalled when its worker has
 * been alive at least the threshold AND its agent lane has been silent at least
 * the threshold. A spawn epoch of 0 (uninitialised slot) or a lane mtime of 0
 * (no lane observed yet — normal startup) is never flagged.
 */
export function computeStalled(
  spawnEpoch: number,
  laneMtime: number,
  now: number,
  thresholdS: number,
): boolean {
  if (!(spawnEpoch > 0)) return false;
  if (!(now - spawnEpoch >= thresholdS)) return false;
  if (!(laneMtime > 0)) return false;
  return now - laneMtime >= thresholdS;
}

// ---------- injected IO ----------

/** A parked-mechanical issue with a landable branch, detected cheaply by the
 * supervisor tick for reconcile dispatch (ADR 0055, #562). */
export interface ReconcileCandidate {
  issue: number;
  branch: string;
}

/** Process side effects the supervisor drives. All real spawn/kill/inspect IO
 * is injected so tests run with no real processes (parity with the bash
 * sup_kill_tree / sup_active_descendant / sup_tree_cpu stubs in the tests). */
export interface SupervisorProc {
  /** Spawn a worker for a slot; returns its pid and spawn epoch. Mirrors
   * spawn_slot's `nohup … &` + bookkeeping. */
  spawnSlot(slot: number): Promise<{ pid: number; spawnEpoch: number }>;
  /** True when the pid is alive (kill -0). Mirrors `kill -0 "$pid"`. */
  isAlive(pid: number): boolean;
  /** kill_tree the pid and its descendants: SIGTERM, grace, then SIGKILL, and
   * CONFIRM the tree is gone (handled by the impl). Mirrors sup_kill_tree.
   * Returns true when death is confirmed, false when the tree survived SIGKILL;
   * a void return (stubs / impls that don't report) is treated as "assume dead".
   * The reaper gates its worktree teardown on this so `rm -rf` never races a
   * still-live worker (#580). */
  killTree(pid: number): Promise<boolean | void>;
  /** Sample the worker tree into the per-process snapshot the reaper-signal
   * reduction consumes (deriveSnapshot). Mirrors sup_descendant_pids feeding
   * sup_active_descendant + sup_tree_cpu. */
  inspectTree(pid: number): readonly ProcessSnapshotEntry[];
  /** Sleep for `ms` between health-check ticks — the poll cadence (RED_AFK_POLL_S).
   * Injected so tests advance the loop without real time. Mirrors the bash
   * `sleep "$POLL_S"` at the bottom of the supervisor `while :` loop. */
  sleep(ms: number): Promise<void>;
  /**
   * Spawn a reconcile worker for `candidate` into `slot` (ADR 0055, #562). The
   * worker validates-and-lands `candidate.branch` without re-running the agent.
   * Returns its pid and spawn epoch. Absent when reconcile dispatch is not wired.
   */
  spawnReconcileWorker?(slot: number, candidate: ReconcileCandidate): Promise<{ pid: number; spawnEpoch: number }>;
  /** Exit code of the last worker that ran in this slot, or null when unknown
   * (killed externally, never spawned, or the impl does not track codes). A
   * clean drain returns 0; null is treated conservatively as non-clean so it
   * still feeds the circuit breaker. Optional so test harnesses that do not
   * track exit codes compile without change. */
  lastExitCode?(slot: number): number | null;
}

/** Filesystem side effects. Best-effort, like the bash `|| true` cleanups. */
export interface SupervisorFs {
  /** Last-modified epoch (seconds) of the slot's agent lane, or 0 when the lane
   * does not exist / the worker is between iterations. Mirrors the
   * `stat -c %Y "$lane"` read in poll_stall_detector. */
  agentLaneMtime(slot: number): number;
  /** Resolve the slot's current iteration dir + the state it carries, or null
   * when the worker is between iterations / died pre-claim. Mirrors
   * find_slot_iter_dir + the jq reads in reap_stalled_slot. */
  resolveIterDir(slot: number): IterDirInfo | null;
  /** Tear down the slot's worktree + iter dir (worktree remove + rm -rf).
   * Mirrors reap_stalled_slot step 4. */
  teardownIterDir(info: IterDirInfo): Promise<void>;
  /** Worker IDs + their claimed (iterDir, issue) pairs that occupied a parked
   * slot. Resolved first from the per-slot slot-log boot-stamp (`[afk] worker:
   * wXXXX` lines the worker emits immediately on startup); falls back to the
   * slot's last known PID (worker.pid match) when the log yields no workers.
   * Mirrors parse_worker_ids_from_log + iter_dirs_for_worker +
   * iter_dir_issue_number. */
  parkedSlotWork(slot: number, lastPid: number | null): SweepWork;
  /** Remove a swept iter dir (rm -rf). Mirrors the per-pair `rm -rf "$dir"`. */
  removeDir(path: string): Promise<void>;
}

/** gh side effects. Best-effort: a failure is logged in bash but never blocks
 * the supervisor; here the impl decides, and the orchestration swallows errors
 * the same way (the workers keep running). */
export interface SupervisorGh {
  /** Post a structured envelope comment on an issue. Mirrors `gh issue comment
   * --body`. */
  comment(issue: number, body: string): Promise<void>;
  /** Rotate labels on an issue. Mirrors `gh issue edit --add-label/--remove-label`. */
  editLabels(issue: number, add: string[], remove: string[]): Promise<void>;
  /** Idempotently ensure the runner-error label exists. Mirrors
   * ensure_runner_error_label. */
  ensureRunnerErrorLabel(): Promise<void>;
  /** Idempotently create an arbitrary label on the fly (best-effort) so a
   * missing typed `blocked:<reason>` observability label never fails the reap.
   * Mirrors the runner-error label-create pattern. */
  ensureLabel(name: string): Promise<void>;
  /** Current open `ready-for-agent` queue depth for the fleet heartbeat. */
  readyQueueDepth?(): Promise<number>;
  /**
   * Cheaply detect the first parked-mechanical issue with an `afk/…` live
   * branch (blocked:stalled | blocked:crashed label + remote branch list). Runs
   * inside the supervisor tick — must complete well under `RED_AFK_TICK_TIMEOUT_S`.
   * Returns null when no candidate is found or on any gh/git failure (best-effort).
   * Absent when reconcile dispatch is not wired.
   */
  findReconcileCandidate?(): Promise<ReconcileCandidate | null>;
}

export interface FleetHeartbeat {
  /** ISO-8601 timestamp for the supervisor tick. */
  ts: string;
  /** Epoch seconds for cheap age calculations in monitor/statusline. */
  epoch: number;
  /**
   * Epoch seconds of the last NON-ABANDONED tick (#579). Only advances when
   * guardedTick completes without timing out or throwing. 0 when no successful
   * tick has been observed yet (freshly-launched supervisor whose first tick was
   * abandoned). The watchdog checks this against progressStaleS; 0 is treated as
   * null (healthy — can't prove a wedge on the first abandoned tick alone).
   */
  lastProgressEpoch: number;
  /** Runner this fleet was launched with — lets the watchdog relaunch a recovered
   * supervisor with the same runner instead of re-detecting from its own tree. */
  runner: string;
  readyForAgent: number;
  slotsBusy: number;
  slotsFree: number;
  slotsTotal: number;
  slotsParked: number;
  spawnsThisTick: number;
}

/** The slot's current iteration, resolved from the filesystem. Mirrors the
 * fields reap_stalled_slot pulls out of afk.state.json. */
export interface IterDirInfo {
  path: string;
  /** .current.number, or null when the worker died before claiming. */
  issue: number | null;
  workerId: string;
  /** Tail of afk.log for the no-sentinel envelope's log section. */
  logTail: string;
  /** Extracted agent notes for the envelope's notes section, if any. */
  notes: string;
  /** Worker lifetime in seconds for the envelope duration, or 0 when unknown. */
  durationS: number;
  /** Real attempt number for this iteration, parsed from the `<issue>-a<N>` iter
   * dir, or 1 when it cannot be derived. Drives the bounded stalled re-claim cap
   * (#402) so a worker that keeps stalling escalates instead of looping forever. */
  attempt: number;
}

/** One worker's claimed iter dirs for the trip sweep. */
export interface SweepWorker {
  workerId: string;
  /** (iterDir, issue) pairs; issue is null when the worker died pre-claim. */
  pairs: { dir: string; issue: number | null }[];
}

/** The worker IDs + claimed work that occupied a parked slot. */
export interface SweepWork {
  workers: SweepWorker[];
  /** Supervisor log path quoted in the discard envelope body. */
  supervisorLogPath: string;
}

/** All injected IO + the clock for one supervisor run. */
export interface SupervisorDeps {
  proc: SupervisorProc;
  fs: SupervisorFs;
  gh: SupervisorGh;
  /** Current epoch seconds (date +%s), injected for determinism. */
  now(): number;
  /**
   * Env view for the bounded stalled re-claim cap (#402). Read by the stall-reaper
   * to resolve `RED_AFK_RETRY_STALLED` via recovery.ts. Defaults to {} (the
   * built-in cap) when absent, so tests can omit it.
   */
  recoveryEnv?: RecoveryEnv;
  /**
   * Optional liveness sink: one line per supervise tick (the CLI appends it to
   * afk-supervisor.log). Makes a healthy fleet's heartbeat — and a wedged one's
   * silence — observable, so an operator never has to guess fleet state from a
   * stale log. Best-effort; never throws.
   */
  log?(line: string): void;
  /**
   * Structured fleet proof-of-life sink: one record per supervise tick. The CLI
   * writes it to the supervisor firehose and state file. Best-effort; never
   * throws out of the loop.
   */
  emitFleetHeartbeat?(heartbeat: FleetHeartbeat): void | Promise<void>;
  /**
   * Run the shared boot sweeps ONCE before the initial fleet spawn (#623). The
   * fleet supervisor owns the boot: it runs orphan cleanup / attempt cap /
   * branch cleanup / unblock sweep / straggler check a single time, pre-spawn,
   * and every worker it then spawns carries the `RED_AFK_SWEEPS_DONE` marker so
   * it boots bootstrap+claim only — respawns are cheap and workers never race
   * peers over shared `.red/tmp` state. Called exactly once per supervisor
   * lifetime (never on a respawn, which happens inside the tick loop). The
   * closure itself logs its sweep results via {@link SupervisorDeps.log}.
   * Best-effort: a throw is caught and logged, never aborting the fleet. Absent
   * in tests / non-fleet contexts → no boot runs (back-compat).
   */
  bootSweeps?(): Promise<void>;
}

// ---------- per-slot runtime state ----------

/** The supervisor's per-slot bookkeeping, mirroring the SLOT_* arrays. A fresh
 * slot is `freshSlot()`. The tick mutates these in place (the bash arrays are
 * global mutable state); tests inspect them after each tick. */
export interface SlotState {
  pid: number | null;
  spawnEpoch: number;
  /** Fast-death ring, pruned to the window (SLOT_FAST_DEATHS). */
  deaths: number[];
  parked: boolean;
  tripEpoch: number;
  /** SLOT_SWEPT — the trip sweep fired once. */
  swept: boolean;
  stalled: boolean;
  /** Epoch the stall window opened (anchored to last lane activity). */
  stallSinceEpoch: number;
  /** SLOT_REAPED — the hard reap fired once. */
  reaped: boolean;
  /** True while a spawnSlot call is in-flight for this slot. Prevents a
   * duplicate spawn on the same slot if an enclosing tick is abandoned by
   * the guardedTick ceiling before the spawn resolves. */
  spawning: boolean;
  /** True when the slot idle-parked after a clean drain (exit 0) with an
   * empty ready queue. Distinct from a breaker-trip park: no sweep is run
   * and the slot un-parks automatically when the queue refills. */
  idleParked: boolean;
  /** Current half-open backoff step (0 = first probe). Increments on each
   * probe fast-death; reset to 0 when the circuit closes (probe success). */
  backoffStep: number;
  /** True when the slot is in half-open state: parked=true AND a probe worker
   * has been spawned. The probe's death resolves to either closed (success)
   * or re-parked-open (fast-death failure). */
  halfOpen: boolean;
}

export function freshSlot(): SlotState {
  return {
    pid: null,
    spawnEpoch: 0,
    deaths: [],
    parked: false,
    tripEpoch: 0,
    swept: false,
    stalled: false,
    stallSinceEpoch: 0,
    reaped: false,
    spawning: false,
    idleParked: false,
    backoffStep: 0,
    halfOpen: false,
  };
}

/** The whole supervisor runtime: one SlotState per target slot. */
export interface SupervisorState {
  slots: SlotState[];
  /**
   * Epoch seconds of the last NON-ABANDONED tick (#579). 0 = no successful tick
   * has been observed yet. Updated by runSupervisor after each non-abandoned
   * guardedTick and carried into every FleetHeartbeat so the watchdog can detect
   * a loop that spins on abandoned ticks.
   */
  lastProgressEpoch: number;
}

/** Build the initial runtime for `target` slots. */
export function initSupervisorState(target: number): SupervisorState {
  return { slots: Array.from({ length: target }, () => freshSlot()), lastProgressEpoch: 0 };
}

// ---------- discard / no-sentinel envelopes (compose envelope.ts) ----------

/** Build the circuit-trip discard envelope body (status "discarded"), composing
 * envelope.ts buildEnvelope. Mirrors build_discard_envelope: the summary names
 * the runner + trip cause, and a single `summary` section carries the slot,
 * worker IDs, fast-death count, and supervisor log path. The worker/duration/
 * diff/attempt summary fields are placeholders for the discard variant. */
export function buildDiscardEnvelope(
  runner: string,
  slot: number,
  workerIdsCsv: string,
  fastDeaths: number,
  supervisorLogPath: string,
): string {
  const sectionBody = [
    `slot: ${slot}`,
    `worker IDs: ${workerIdsCsv}`,
    `fast deaths: ${fastDeaths}`,
    `supervisor log: ${supervisorLogPath}`,
  ].join("\n");
  return buildEnvelope({
    status: "discarded",
    worker: runner,
    duration: `runner-broken, slot parked after ${fastDeaths} fast deaths`,
    diff: "discarded",
    attempt: 1,
    sections: [{ name: "summary", body: sectionBody }],
  });
}

/** Build the stall-reaper no-sentinel envelope body, composing envelope.ts
 * buildEnvelope. Mirrors the `summary` + notes + log envelope reap_stalled_slot
 * posts: status "no-sentinel", a notes section and a fenced log section. */
export function buildReaperEnvelope(info: IterDirInfo): string {
  return buildEnvelope({
    status: "no-sentinel",
    worker: info.workerId.length > 0 ? info.workerId : "unknown",
    duration: `${info.durationS}s · stall-reaped`,
    diff: "stall-reaped",
    attempt: info.attempt,
    sections: [
      { name: "notes", body: info.notes.length > 0 ? info.notes : "(no agent notes recorded before stall-reap)" },
      { name: "log", body: info.logTail, fenced: true },
    ],
  });
}

// ---------- actions (compose deciders, apply via injected IO) ----------

/** Outcome of one supervise tick, for parity assertions / logging. */
export interface TickResult {
  respawned: number[];
  /** Slots whose worker died and were handled (respawn or park). */
  deaths: number[];
  /** Slots parked by a circuit-breaker trip this tick. */
  parked: number[];
  /** Slots that entered idle-park this tick (clean drain, empty queue). */
  idleParked: number[];
  /** Slots whose cooldown expired and a half-open probe was spawned this tick. */
  halfOpened: number[];
  reaped: number[];
  /** Slots into which a reconcile worker was dispatched this tick. */
  reconciledSlots: number[];
  /** True when the stop-file was honoured and all workers terminated. */
  stopped: boolean;
  /** Ready-queue depth sampled at the start of this tick (0 on an abandoned
   * tick or when readyQueueDepth is unavailable). Used by emitFleetHeartbeat
   * so the queue is fetched exactly once per tick. */
  queueDepth: number;
  /**
   * True when the tick was abandoned — guardedTick timed out or threw. An
   * abandoned tick does NOT advance lastProgressEpoch in the heartbeat; only
   * ticks that complete normally are counted as "forward progress" (#579).
   */
  abandoned: boolean;
}

function fleetSlotCounts(state: SupervisorState): Pick<FleetHeartbeat, "slotsBusy" | "slotsFree" | "slotsTotal" | "slotsParked"> {
  let slotsBusy = 0;
  let slotsFree = 0;
  let slotsParked = 0;
  for (const slot of state.slots) {
    if (slot.parked || slot.idleParked) {
      slotsParked += 1;
    } else if (slot.pid === null) {
      slotsFree += 1;
    } else {
      slotsBusy += 1;
    }
  }
  return { slotsBusy, slotsFree, slotsTotal: state.slots.length, slotsParked };
}

function isoFromEpoch(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

async function emitFleetHeartbeat(
  state: SupervisorState,
  deps: SupervisorDeps,
  result: TickResult,
  runner: string,
): Promise<FleetHeartbeat> {
  // Queue depth was fetched once by superviseTick at the start of this tick
  // and stored in result.queueDepth — reuse it here so there is exactly one
  // readyQueueDepth call per tick (0 on a stop tick or abandoned tick).
  const readyForAgent = result.queueDepth;
  const epoch = deps.now();
  const heartbeat: FleetHeartbeat = {
    ts: isoFromEpoch(epoch),
    epoch,
    lastProgressEpoch: state.lastProgressEpoch,
    runner,
    readyForAgent,
    ...fleetSlotCounts(state),
    spawnsThisTick: result.respawned.length,
  };
  try {
    await deps.emitFleetHeartbeat?.(heartbeat);
  } catch {
    // best-effort: heartbeat IO must never affect supervisor scheduling.
  }
  return heartbeat;
}

/**
 * sweep_parked_slot (supervisor.sh ~767): the circuit-trip sweep. Idempotent
 * per slot via SlotState.swept. For each claimed issue an affected worker held:
 * ensure the runner-error label, post a discard envelope, and rotate labels
 * (+ready-for-agent +runner-error -ready-for-human -running). Every iter dir
 * the parked slot's workers held is removed regardless of claim. A sweep with
 * no observed workers, or with workers that never claimed, posts no envelope and
 * edits no labels but still cleans iter dirs.
 */
export async function sweepParkedSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  config: Pick<SupervisorConfig, "runner">,
): Promise<void> {
  if (state.swept) return;
  state.swept = true;

  // state.pid is the last dead worker's PID — the fs layer uses it as a
  // fallback when the slot log has no boot-stamp (native fleet path).
  const work = deps.fs.parkedSlotWork(slot, state.pid);
  if (work.workers.length === 0) return;

  const workerIdsCsv = work.workers.map((w) => w.workerId).join(",");
  // Real fast-death count lives in the circuit ring at the time of the trip,
  // not in the FS layer (which has no visibility into the breaker state).
  const fastDeaths = state.deaths.length;
  const hasAnyClaim = work.workers.some((w) => w.pairs.some((p) => p.issue !== null));
  if (hasAnyClaim) await deps.gh.ensureRunnerErrorLabel();

  for (const worker of work.workers) {
    for (const pair of worker.pairs) {
      if (pair.issue !== null) {
        const body = buildDiscardEnvelope(
          config.runner,
          slot,
          workerIdsCsv,
          fastDeaths,
          work.supervisorLogPath,
        );
        await deps.gh.comment(pair.issue, body);
        await deps.gh.editLabels(
          pair.issue,
          [LABEL_READY, LABEL_RUNNER_ERROR],
          [LABEL_HUMAN, LABEL_RUNNING],
        );
      }
      await deps.fs.removeDir(pair.dir);
    }
  }
}

/**
 * reap_stalled_slot (supervisor.sh ~868): hard-reap a slot silent past the kill
 * threshold. Idempotent per slot via SlotState.reaped. Order (every step
 * best-effort past the kill):
 *   1. kill_tree the orchestrator when alive.
 *   2. Free the slot bookkeeping so the next tick respawns it.
 *   3. When an issue number was recovered: post a no-sentinel envelope and
 *      rotate labels back (+ready-for-agent -running).
 *   4. Tear down worktree + iter dir.
 * A worker that died pre-claim (issue null) still kills, frees the slot, and
 * tears down the dir, but posts no envelope and rotates no labels.
 */
export async function reapStalledSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
): Promise<void> {
  if (state.reaped) return;
  state.reaped = true;

  const orchPid = state.pid;
  const info = deps.fs.resolveIterDir(slot);

  // 1. kill_tree the orchestrator — SIGTERM, grace, SIGKILL, confirm exit.
  // `confirmedDead` gates the destructive teardown in step 4: a worker already
  // gone (no pid / not alive) is trivially dead; otherwise we trust killTree's
  // confirmation. Only a definitive `false` (survived SIGKILL) blocks teardown.
  let confirmedDead = true;
  if (orchPid !== null && deps.proc.isAlive(orchPid)) {
    const killed = await deps.proc.killTree(orchPid);
    confirmedDead = killed !== false;
  }

  // 2. Free the slot — next tick respawns it even if cleanup below fails.
  state.pid = null;
  state.stalled = false;
  state.stallSinceEpoch = 0;

  // 3. Envelope + BOUNDED re-claim routing (only with a recovered issue number).
  // The stall-reaper is now capped (#402): it asks recovery.ts whether this
  // attempt may retry. While under the `stalled` cap it rotates back to
  // ready-for-agent CLEAN — no `blocked:*` label rides along, so a re-queued issue
  // never trips the adoption-doctor's "ready-for-agent + blocked:*" hygiene check.
  // Once the cap is exhausted it escalates to ready-for-human carrying
  // `blocked:stalled` (created on the fly) plus a self-explanatory page comment,
  // exactly like the per-issue routeRecovery escalation.
  if (info && info.issue !== null) {
    await deps.gh.comment(info.issue, buildReaperEnvelope(info));
    const env = deps.recoveryEnv ?? {};
    const decision = recoveryDecision("stalled", info.attempt, env);
    if (decision === "retry") {
      await deps.gh.editLabels(info.issue, [LABEL_READY], [LABEL_RUNNING]);
    } else {
      const typed = blockedLabelFor("stalled");
      if (typed !== null) await deps.gh.ensureLabel(typed);
      await deps.gh.editLabels(
        info.issue,
        typed !== null ? [LABEL_HUMAN, typed] : [LABEL_HUMAN],
        [LABEL_RUNNING, LABEL_READY],
      );
      const cap = recoveryCap("stalled", env);
      if (cap !== null) {
        await deps.gh.comment(
          info.issue,
          `🤖 /afk escalating to ready-for-human: blocked:stalled retry budget exhausted (attempt ${info.attempt}/${cap}).`,
        );
      }
    }
  }

  // 4. Teardown — only once the worker is confirmed dead, so the `rm -rf` of the
  // worktree never races a still-live worker still writing into it (#580). A
  // worker that survived SIGKILL leaks its worktree (cleaned up on the next boot
  // sweep), which is strictly safer than corrupting a live checkout.
  if (info && confirmedDead) await deps.fs.teardownIterDir(info);
}

/**
 * pollStallDetector (supervisor.sh ~611): sample every non-parked slot. Flag /
 * clear the stall bit from the agent-lane mtime vs the stall threshold, then —
 * for a slot silent past the kill threshold and not yet reaped — gate the
 * irreversible kill behind the reaper-signal predicate. The kill fires only
 * when decideReaperSignal returns "kill" (idle past threshold AND no active
 * build/test descendant AND flat cpu); a busy worker is left alone. Composes
 * deriveSnapshot + decideReaperSignal — never re-implements them.
 */
export async function pollStallDetector(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: Pick<SupervisorConfig, "stallThresholdS" | "stallKillThresholdS">,
): Promise<number[]> {
  const now = deps.now();
  const reaped: number[] = [];

  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (slot.parked || slot.idleParked) continue;

    const laneMtime = deps.fs.agentLaneMtime(i);
    const flagged = computeStalled(slot.spawnEpoch, laneMtime, now, config.stallThresholdS);

    if (flagged) {
      if (!slot.stalled) {
        slot.stalled = true;
        // Anchor the stall window to the last observed lane activity so the
        // rendered idle duration matches "agent lane idle for N".
        slot.stallSinceEpoch = laneMtime;
      }
      // Hard-reap escalation: candidacy alone is not death — gate the kill.
      const since = slot.stallSinceEpoch;
      if (since > 0 && now - since >= config.stallKillThresholdS && !slot.reaped) {
        const orchPid = slot.pid;
        const snapshot =
          orchPid !== null
            ? deriveSnapshot(deps.proc.inspectTree(orchPid))
            : { activeDescendant: false, cpuPct: 0 };
        const decision = decideReaperSignal({
          idleSeconds: now - since,
          idleThresholdSeconds: config.stallKillThresholdS,
          activeDescendant: snapshot.activeDescendant,
          cpuPct: snapshot.cpuPct,
        });
        if (decision === "kill") {
          await reapStalledSlot(i, slot, deps);
          reaped.push(i);
        }
      }
    } else if (slot.stalled) {
      slot.stalled = false;
      slot.stallSinceEpoch = 0;
    }
  }

  return reaped;
}

/**
 * handle_dead_slot (supervisor.sh ~994): a slot whose worker exited. Record the
 * death against the circuit breaker; on a trip park the slot and run the trip
 * sweep, otherwise respawn. Returns whether the slot parked. Compose recordDeath
 * (pure) then apply the spawn / sweep side effects.
 *
 * A clean exit (exit code 0, i.e. NO_MORE_TASKS / empty queue drain) is exempt
 * from the circuit breaker: it is never a fast-death, so K consecutive drains
 * can never trip the breaker. When the queue is empty the slot idle-parks
 * (no sweep, no discard envelope); when the queue has work it respawns
 * immediately. Non-zero / unknown exit codes follow the original breaker logic.
 *
 * The spawning flag is set around the spawnSlot await so that a tick abandoned
 * by the guardedTick ceiling (hung gh/ps call elsewhere in the tick) does not
 * double-spawn the slot on the next pass.
 */
export async function handleDeadSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  queueDepth = 0,
): Promise<{ parked: boolean }> {
  // Half-open probe death: resolve the circuit transition before the normal path.
  if (state.parked && state.halfOpen) {
    const now = deps.now();
    const lifetime = state.spawnEpoch > 0 ? now - state.spawnEpoch : 0;
    const fastDeath = state.spawnEpoch > 0 && lifetime < config.fastDeathThresholdS;
    state.halfOpen = false;
    state.pid = null;
    if (fastDeath) {
      // Probe fast-died: re-park with next backoff step, sweep already ran on
      // the original trip so we do NOT re-sweep.
      state.backoffStep++;
      state.tripEpoch = now;
      deps.log?.(
        `circuit re-parked: slot ${slot} probe fast-death (${lifetime}s), ` +
          `next backoff=${computeHalfOpenBackoff(state.backoffStep, config)}s step=${state.backoffStep}`,
      );
      return { parked: true };
    }
    // Probe survived long enough: close the circuit and reset backoff.
    state.parked = false;
    state.backoffStep = 0;
    state.tripEpoch = 0;
    state.swept = false; // allow sweep on a future trip
    state.deaths = []; // reset the fast-death ring
    deps.log?.(`circuit closed: slot ${slot} probe succeeded (${lifetime}s), backoff reset`);
    // Respawn immediately so the closed slot has a live worker.
    state.spawning = true;
    try {
      const spawned = await deps.proc.spawnSlot(slot);
      state.pid = spawned.pid;
      state.spawnEpoch = spawned.spawnEpoch;
    } finally {
      state.spawning = false;
    }
    state.stalled = false;
    state.stallSinceEpoch = 0;
    state.reaped = false;
    return { parked: false };
  }

  const exitCode = deps.proc.lastExitCode?.(slot) ?? null;
  const cleanExit = exitCode === 0;

  if (cleanExit) {
    if (queueDepth === 0) {
      // Clean drain with empty queue → idle-park (no sweep, no discard envelope).
      state.idleParked = true;
      return { parked: true };
    }
    // Clean drain but queue has work → respawn immediately without feeding the breaker.
    state.spawning = true;
    try {
      const spawned = await deps.proc.spawnSlot(slot);
      state.pid = spawned.pid;
      state.spawnEpoch = spawned.spawnEpoch;
    } finally {
      state.spawning = false;
    }
    state.stalled = false;
    state.stallSinceEpoch = 0;
    state.reaped = false;
    return { parked: false };
  }

  // Non-clean exit: record against the circuit breaker.
  const now = deps.now();
  const decision = recordDeath(state.deaths, state.spawnEpoch, now, config);
  state.deaths = decision.deaths;

  if (decision.trip) {
    state.parked = true;
    state.tripEpoch = now;
    await sweepParkedSlot(slot, state, deps, config);
    return { parked: true };
  }

  state.spawning = true;
  try {
    const spawned = await deps.proc.spawnSlot(slot);
    state.pid = spawned.pid;
    state.spawnEpoch = spawned.spawnEpoch;
  } finally {
    state.spawning = false;
  }
  // A respawn opens a fresh worker lifetime; clear any stale stall flags.
  state.stalled = false;
  state.stallSinceEpoch = 0;
  state.reaped = false;
  return { parked: false };
}

/**
 * dispatchReconcileIfPossible — attempt to dispatch ONE reconcile worker into
 * the first free slot (ADR 0055, #562). Called at the end of every superviseTick,
 * after normal lifecycle handling (respawn / stall / reap). Returns the slot
 * index of the dispatched worker, or null when no dispatch occurred.
 *
 * A "free slot" is one that is not parked and has no live pid — typically freed
 * by the stall-reaper within the same tick. The heavy validate+land runs in the
 * worker process (its own timeout), off the tick's critical path.
 *
 * Both `deps.proc.spawnReconcileWorker` and `deps.gh.findReconcileCandidate` are
 * optional — when either is absent this is a no-op, preserving backward
 * compatibility with existing SupervisorDeps implementations (tests, boot-only).
 */
export async function dispatchReconcileIfPossible(
  state: SupervisorState,
  deps: SupervisorDeps,
): Promise<number | null> {
  if (!deps.proc.spawnReconcileWorker || !deps.gh.findReconcileCandidate) return null;

  // Find the first free slot: not parked and no live pid.
  const freeIdx = state.slots.findIndex((s) => !s.parked && s.pid === null);
  if (freeIdx < 0) return null;

  // Cheap detection: one gh label query + remote branch list via the injected closure.
  let candidate: ReconcileCandidate | null = null;
  try {
    candidate = await deps.gh.findReconcileCandidate();
  } catch {
    return null;
  }
  if (candidate === null) return null;

  // Dispatch the reconcile worker into the free slot.
  const spawned = await deps.proc.spawnReconcileWorker(freeIdx, candidate);
  const slot = state.slots[freeIdx]!;
  slot.pid = spawned.pid;
  slot.spawnEpoch = spawned.spawnEpoch;
  // Clear stale stall/reap flags — this is a fresh worker start.
  slot.stalled = false;
  slot.stallSinceEpoch = 0;
  slot.reaped = false;
  return freeIdx;
}

/**
 * superviseTick — advance the health-check loop one cycle (the body of
 * supervisor.sh's `while :` at ~1122-1141). In order:
 *   1. honour the stop-file: terminate every worker and return early.
 *   2. sample ready-queue depth (single fetch per tick, shared with heartbeat).
 *   3. un-park idle-parked slots when the queue has work.
 *   4. respawn / park dead non-parked, non-idle-parked, non-spawning slots.
 *   5. poll the passive stall detector + gated hard reaper (pollStallDetector).
 *   6. reconcile dispatch: fill a free slot with a reconcile worker if eligible.
 *
 * `stopRequested` is the injected stop-file probe (the bash `[[ -f $STOP_FILE ]]`
 * check). The real loop is `while (!await superviseTick(...).stopped)`.
 */
export async function superviseTick(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  stopRequested: () => boolean,
): Promise<TickResult> {
  const result: TickResult = {
    respawned: [],
    deaths: [],
    parked: [],
    idleParked: [],
    halfOpened: [],
    reaped: [],
    reconciledSlots: [],
    stopped: false,
    queueDepth: 0,
    abandoned: false,
  };

  if (stopRequested()) {
    await terminateAll(state, deps);
    result.stopped = true;
    return result;
  }

  // Sample queue depth once per tick for idle-park / un-park decisions and the
  // fleet heartbeat. Best-effort: 0 on any failure or missing implementation.
  let queueDepth = 0;
  try {
    queueDepth = (await deps.gh.readyQueueDepth?.()) ?? 0;
  } catch {
    queueDepth = 0;
  }
  result.queueDepth = queueDepth;

  // Un-park idle-parked slots when the queue has work to do.
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (!slot.idleParked || queueDepth === 0) continue;
    slot.idleParked = false;
    slot.spawning = true;
    try {
      const spawned = await deps.proc.spawnSlot(i);
      slot.pid = spawned.pid;
      slot.spawnEpoch = spawned.spawnEpoch;
      slot.stalled = false;
      slot.stallSinceEpoch = 0;
      slot.reaped = false;
    } finally {
      slot.spawning = false;
    }
    result.respawned.push(i);
  }

  // Schedule half-open probes for circuit-tripped slots whose cooldown has expired.
  // A parked slot without a probe (halfOpen=false) transitions to half-open when
  // now - tripEpoch >= backoff(step). The probe is a normal worker spawn; its death
  // is handled by handleDeadSlot which detects the halfOpen flag.
  {
    const now = deps.now();
    for (let i = 0; i < state.slots.length; i += 1) {
      const slot = state.slots[i]!;
      if (!slot.parked || slot.halfOpen || slot.spawning) continue;
      if (!isHalfOpenDue(slot.tripEpoch, slot.backoffStep, now, config)) continue;
      deps.log?.(
        `circuit half-open: slot ${i} cooldown expired, spawning probe ` +
          `(backoff=${computeHalfOpenBackoff(slot.backoffStep, config)}s step=${slot.backoffStep})`,
      );
      slot.halfOpen = true;
      slot.spawning = true;
      try {
        const spawned = await deps.proc.spawnSlot(i);
        slot.pid = spawned.pid;
        slot.spawnEpoch = spawned.spawnEpoch;
        slot.stalled = false;
        slot.stallSinceEpoch = 0;
        slot.reaped = false;
      } finally {
        slot.spawning = false;
      }
      result.halfOpened.push(i);
    }
  }

  // Respawn / park dead non-parked, non-idle-parked, non-spawning slots.
  // `slot.spawning` guards against a duplicate spawn when the enclosing tick
  // was abandoned mid-spawnSlot by the guardedTick ceiling.
  // Also processes half-open probe deaths (parked=true, halfOpen=true).
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    // Skip: open (parked but not probing), idleParked, or spawning in-flight.
    if ((slot.parked && !slot.halfOpen) || slot.idleParked || slot.spawning) continue;
    const pid = slot.pid;
    if (pid === null || !deps.proc.isAlive(pid)) {
      result.deaths.push(i);
      const { parked } = await handleDeadSlot(i, slot, deps, config, queueDepth);
      if (parked) {
        if (slot.idleParked) result.idleParked.push(i);
        else result.parked.push(i);
      } else {
        result.respawned.push(i);
      }
    }
  }

  // Passive stall detector + gated hard reaper.
  const reaped = await pollStallDetector(state, deps, config);
  result.reaped = reaped;

  // Reconcile dispatch: use any free slot (e.g. just stall-reaped) for a parked
  // candidate. Best-effort; a failure or absent candidate is silently skipped.
  const reconciledSlot = await dispatchReconcileIfPossible(state, deps);
  if (reconciledSlot !== null) result.reconciledSlots.push(reconciledSlot);

  return result;
}

/**
 * terminate_all (supervisor.sh ~1036): kill every live slot worker on shutdown
 * via the wait-and-escalate killTree (SIGTERM → grace → SIGKILL → confirm), so a
 * SIGTERM-ignoring worker does not survive the supervisor's exit (#580).
 * Best-effort.
 */
export async function terminateAll(state: SupervisorState, deps: SupervisorDeps): Promise<void> {
  for (const slot of state.slots) {
    const pid = slot.pid;
    if (pid !== null && deps.proc.isAlive(pid)) {
      await deps.proc.killTree(pid);
    }
  }
}

/**
 * The supervisor's startup + health-check loop, composing the steps above. This
 * is the testable shape of supervisor.sh's main body (~1109-1141): validate
 * thresholds, spawn the initial fleet to target, then tick until the stop-file
 * appears. Between ticks it sleeps the poll cadence (config.pollIntervalS, via
 * the injected deps.proc.sleep) so the loop never busy-spins.
 */
export async function runSupervisor(
  state: SupervisorState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
  stopRequested: () => boolean,
): Promise<void> {
  validateStallThresholds(config);
  // The external watchdog (#407) reads this heartbeat to recover a hard-hung
  // loop; refuse to boot with a threshold that could misread a slow-but-live
  // tick as quiescent.
  validateSupervisorStaleThreshold(config);
  // The progress-stale check (#579) must fire strictly after the heartbeat-stale
  // check, so its threshold must be greater.
  validateSupervisorProgressThreshold(config);

  // Fleet supervisor owns the boot (#623): run the shared sweeps ONCE, pre-spawn,
  // so every worker the fleet spawns boots bootstrap+claim only and never races
  // peers over `.red/tmp` state. This is the ONLY call site — a respawn after a
  // worker exit happens inside the tick loop below and never re-enters here, so
  // the sweeps run exactly once per supervisor lifetime. Best-effort: a boot
  // failure is logged, not fatal (each worker still runs its own precheck).
  if (deps.bootSweeps) {
    try {
      await deps.bootSweeps();
    } catch (err) {
      deps.log?.(
        `boot sweeps failed: ${err instanceof Error ? err.message : String(err)} — spawning workers anyway`,
      );
    }
  }

  // Spawn the initial fleet to target.
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    const spawned = await deps.proc.spawnSlot(i);
    slot.pid = spawned.pid;
    slot.spawnEpoch = spawned.spawnEpoch;
  }

  // Health-check loop until the stop-file, sleeping the poll cadence each pass.
  // Every tick is bounded by `guardedTick`: a hung tick (gh/ps/git await with no
  // timeout) is abandoned after tickTimeoutS and the loop continues — the
  // supervisor can no longer go alive-but-quiescent. Each pass logs a heartbeat
  // so the fleet's liveness is observable.
  for (;;) {
    const result = await guardedTick(
      () => superviseTick(state, deps, config, stopRequested),
      config.tickTimeoutS * 1000,
      deps.proc.sleep,
      deps.log,
    );
    // Advance the progress epoch only when the tick was NOT abandoned. An
    // abandoned tick (timeout / throw) is loop-liveness, not work-progress.
    if (!result.abandoned) {
      state.lastProgressEpoch = deps.now();
    }
    const heartbeat = await emitFleetHeartbeat(state, deps, result, config.runner);
    deps.log?.(
      `tick: slots=${state.slots.length} respawned=${result.respawned.length} ` +
        `deaths=${result.deaths.length} parked=${result.parked.length} idle-parked=${result.idleParked.length} ` +
        `half-opened=${result.halfOpened.length} reaped=${result.reaped.length} ` +
        `ready=${heartbeat.readyForAgent} busy=${heartbeat.slotsBusy} free=${heartbeat.slotsFree}`,
    );
    if (result.stopped) return;
    await deps.proc.sleep(config.pollIntervalS * 1000);
  }
}

/** A non-stop tick result (the abandon/error fallback). The `abandoned` flag
 * tells runSupervisor not to advance lastProgressEpoch for this pass. */
function continueResult(): TickResult {
  return { respawned: [], deaths: [], parked: [], idleParked: [], halfOpened: [], reaped: [], reconciledSlots: [], stopped: false, queueDepth: 0, abandoned: true };
}

/**
 * Run one supervise tick under a wall-clock ceiling. A tick that exceeds
 * `timeoutMs` (a hung gh/ps/git await) or throws is abandoned — logged, and a
 * non-stop result returned — so the supervisor loop continues to the next pass
 * instead of freezing forever on the await. Pure over an injected `sleep`
 * (the timeout clock) so it is deterministically testable with no real timers.
 * The abandoned tick promise is left to settle on its own; the loop moves on.
 */
export async function guardedTick(
  tick: () => Promise<TickResult>,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void>,
  log?: (line: string) => void,
): Promise<TickResult> {
  const TIMEOUT = Symbol("tick-timeout");
  try {
    const raced = await Promise.race<TickResult | typeof TIMEOUT>([
      tick(),
      sleep(timeoutMs).then(() => TIMEOUT),
    ]);
    if (raced === TIMEOUT) {
      log?.(`tick exceeded ${Math.round(timeoutMs / 1000)}s — abandoning this pass, loop continues`);
      return continueResult();
    }
    return raced;
  } catch (err) {
    log?.(`tick threw: ${err instanceof Error ? err.message : String(err)} — loop continues`);
    return continueResult();
  }
}
