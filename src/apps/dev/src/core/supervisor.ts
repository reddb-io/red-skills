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
 * classifySupervisor — the pure quiescence detector (#407). A live PID is
 * "quiescent" only when its last heartbeat is at least `staleS` seconds old; a
 * missing heartbeat (a freshly-launched supervisor that has not ticked yet) is
 * never enough to prove a wedge, so it stays "healthy" — the watchdog must never
 * kill a supervisor that simply has not emitted its first heartbeat. Clock skew
 * (a heartbeat stamped in the future) yields a negative age < staleS → healthy.
 */
export function classifySupervisor(
  liveness: SupervisorLiveness,
  now: number,
  staleS: number,
): SupervisorHealth {
  if (liveness.pid === null || !liveness.pidAlive) return "absent";
  if (liveness.lastHeartbeatEpoch === null) return "healthy";
  return now - liveness.lastHeartbeatEpoch >= staleS ? "quiescent" : "healthy";
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

/** Process side effects the supervisor drives. All real spawn/kill/inspect IO
 * is injected so tests run with no real processes (parity with the bash
 * sup_kill_tree / sup_active_descendant / sup_tree_cpu stubs in the tests). */
export interface SupervisorProc {
  /** Spawn a worker for a slot; returns its pid and spawn epoch. Mirrors
   * spawn_slot's `nohup … &` + bookkeeping. */
  spawnSlot(slot: number): Promise<{ pid: number; spawnEpoch: number }>;
  /** True when the pid is alive (kill -0). Mirrors `kill -0 "$pid"`. */
  isAlive(pid: number): boolean;
  /** kill_tree the pid and its descendants (TERM, grace, then KILL handled by
   * the impl). Mirrors sup_kill_tree. */
  killTree(pid: number): Promise<void>;
  /** Sample the worker tree into the per-process snapshot the reaper-signal
   * reduction consumes (deriveSnapshot). Mirrors sup_descendant_pids feeding
   * sup_active_descendant + sup_tree_cpu. */
  inspectTree(pid: number): readonly ProcessSnapshotEntry[];
  /** Sleep for `ms` between health-check ticks — the poll cadence (RED_AFK_POLL_S).
   * Injected so tests advance the loop without real time. Mirrors the bash
   * `sleep "$POLL_S"` at the bottom of the supervisor `while :` loop. */
  sleep(ms: number): Promise<void>;
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
}

export interface FleetHeartbeat {
  /** ISO-8601 timestamp for the supervisor tick. */
  ts: string;
  /** Epoch seconds for cheap age calculations in monitor/statusline. */
  epoch: number;
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
  };
}

/** The whole supervisor runtime: one SlotState per target slot. */
export interface SupervisorState {
  slots: SlotState[];
}

/** Build the initial runtime for `target` slots. */
export function initSupervisorState(target: number): SupervisorState {
  return { slots: Array.from({ length: target }, () => freshSlot()) };
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
  parked: number[];
  reaped: number[];
  /** True when the stop-file was honoured and all workers terminated. */
  stopped: boolean;
}

function fleetSlotCounts(state: SupervisorState): Pick<FleetHeartbeat, "slotsBusy" | "slotsFree" | "slotsTotal" | "slotsParked"> {
  let slotsBusy = 0;
  let slotsFree = 0;
  let slotsParked = 0;
  for (const slot of state.slots) {
    if (slot.parked) {
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
  let readyForAgent = 0;
  try {
    readyForAgent = (await deps.gh.readyQueueDepth?.()) ?? 0;
  } catch {
    readyForAgent = 0;
  }
  const epoch = deps.now();
  const heartbeat: FleetHeartbeat = {
    ts: isoFromEpoch(epoch),
    epoch,
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
          ["ready-for-agent", "runner-error"],
          ["ready-for-human", "running"],
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

  // 1. kill_tree the orchestrator.
  if (orchPid !== null && deps.proc.isAlive(orchPid)) {
    await deps.proc.killTree(orchPid);
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
      await deps.gh.editLabels(info.issue, ["ready-for-agent"], ["running"]);
    } else {
      const typed = blockedLabelFor("stalled");
      if (typed !== null) await deps.gh.ensureLabel(typed);
      await deps.gh.editLabels(
        info.issue,
        typed !== null ? ["ready-for-human", typed] : ["ready-for-human"],
        ["running", "ready-for-agent"],
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

  // 4. Teardown.
  if (info) await deps.fs.teardownIterDir(info);
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
    if (slot.parked) continue;

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
 */
export async function handleDeadSlot(
  slot: number,
  state: SlotState,
  deps: SupervisorDeps,
  config: SupervisorConfig,
): Promise<{ parked: boolean }> {
  const now = deps.now();
  const decision = recordDeath(state.deaths, state.spawnEpoch, now, config);
  state.deaths = decision.deaths;

  if (decision.trip) {
    state.parked = true;
    state.tripEpoch = now;
    await sweepParkedSlot(slot, state, deps, config);
    return { parked: true };
  }

  const spawned = await deps.proc.spawnSlot(slot);
  state.pid = spawned.pid;
  state.spawnEpoch = spawned.spawnEpoch;
  // A respawn opens a fresh worker lifetime; clear any stale stall flags.
  state.stalled = false;
  state.stallSinceEpoch = 0;
  state.reaped = false;
  return { parked: false };
}

/**
 * superviseTick — advance the health-check loop one cycle (the body of
 * supervisor.sh's `while :` at ~1122-1141). In order:
 *   1. honour the stop-file: terminate every worker and return early.
 *   2. respawn / park dead non-parked slots (handleDeadSlot).
 *   3. poll the passive stall detector + gated hard reaper (pollStallDetector).
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
    reaped: [],
    stopped: false,
  };

  if (stopRequested()) {
    await terminateAll(state, deps);
    result.stopped = true;
    return result;
  }

  // Respawn / park dead slots.
  for (let i = 0; i < state.slots.length; i += 1) {
    const slot = state.slots[i]!;
    if (slot.parked) continue;
    const pid = slot.pid;
    if (pid === null || !deps.proc.isAlive(pid)) {
      result.deaths.push(i);
      const { parked } = await handleDeadSlot(i, slot, deps, config);
      if (parked) result.parked.push(i);
      else result.respawned.push(i);
    }
  }

  // Passive stall detector + gated hard reaper.
  const reaped = await pollStallDetector(state, deps, config);
  result.reaped = reaped;

  return result;
}

/**
 * terminate_all (supervisor.sh ~1036): send SIGTERM (via killTree) to every live
 * slot worker on shutdown. Best-effort.
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
    const heartbeat = await emitFleetHeartbeat(state, deps, result, config.runner);
    deps.log?.(
      `tick: slots=${state.slots.length} respawned=${result.respawned.length} ` +
        `deaths=${result.deaths.length} parked=${result.parked.length} reaped=${result.reaped.length} ` +
        `ready=${heartbeat.readyForAgent} busy=${heartbeat.slotsBusy} free=${heartbeat.slotsFree}`,
    );
    if (result.stopped) return;
    await deps.proc.sleep(config.pollIntervalS * 1000);
  }
}

/** A non-stop tick result (the abandon/error fallback). */
function continueResult(): TickResult {
  return { respawned: [], deaths: [], parked: [], reaped: [], stopped: false };
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
