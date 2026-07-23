import type { LivenessVerdict } from "@reddb-io/red-castle";
import type { CastleLaneRecord } from "@reddb-io/red-castle/engine";
import type { ProcessSnapshotEntry } from "../reaper-signal.js";
import type { RecoveryEnv } from "../recovery.js";
import type { WakeSource } from "../event-wake.js";
import type { FleetHookContext, FleetHookDispatchResult } from "../fleet-hook-dispatcher.js";
import type { FleetHookName } from "../fleet-hook-config.js";
import type { DrainBudgetStatus, ElasticResizeRequest, ElasticShrinkMode } from "./config.js";


/**
 * compute_stalled is deleted — stall detection now uses the red-castle
 * LivenessVerdict from SupervisorFs.workerLivenessVerdict (ADR 0083 §3).
 * The evaluator combines lane recency with a process cross-check so a worker
 * that refreshes the firehose but not the liveness lane can no longer defeat
 * the kill, and a worker with live agent descendants is never falsely reaped.
 * The spawnEpoch guard (don't flag freshly started workers) is kept inline in
 * pollStallDetector so the "just spawned" window still applies.

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
  spawnSlot(slot: number, policy?: SpawnPolicy): Promise<{ pid: number; spawnEpoch: number }>;
  /** True when the pid is alive (kill -0). Mirrors `kill -0 "$pid"`. */
  isAlive(pid: number): boolean;
  /** Last persisted worker pid for a slot, used by a relaunched supervisor to
   * adopt surviving detached workers instead of spawning a parallel fleet. */
  slotPid?(slot: number): number | null;
  /** kill_tree the pid and its descendants: SIGTERM, grace, then SIGKILL, and
   * CONFIRM the tree is gone (handled by the impl). Mirrors sup_kill_tree.
   * Returns true when death is confirmed, false when the tree survived SIGKILL;
   * a void return (stubs / impls that don't report) is treated as "assume dead".
   * The reaper gates its worktree teardown on this so `rm -rf` never races a
   * still-live worker (#580). */
  killTree(pid: number): Promise<boolean | void>;
  /** Ask a live slot worker to finish its current claim and exit before the next
   * claim. Optional: older runtimes simply leave the supervisor-side retiring
   * flag active until the worker exits. */
  requestSlotRetire?(slot: number, pid: number): Promise<void>;
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
  /**
   * Red-castle evaluator verdict for the slot's current attempt (ADR 0083 §3).
   * The `laneIdleMs` parameter sets the idle threshold so the supervisor can
   * use its configured stall window rather than the display threshold, and
   * `issueWallClockMaxMs` carries the activity-independent per-issue ceiling
   * (#2286) so an attempt that never converges cannot hold a slot forever.
   * Returns null when no iter dir is found (worker between iterations or died
   * pre-claim). Replaces the old `agentLaneMtime` firehose-mtime check.
   */
  workerLivenessVerdict(
    slot: number,
    laneIdleMs: number,
    laneHardIdleMs?: number,
    issueWallClockMaxMs?: number,
  ): LivenessVerdict | null;
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
  /**
   * Cumulative fleet spend for this drain, derived from existing WorkerVitals
   * state (`current.cost_usd`) rather than a parallel accounting channel.
   */
  fleetCostUsd?(): number;
}

export interface SpawnPolicy {
  /** Set at CRITICAL so the spawned worker downgrades one model-policy tier. */
  taskTierDowngrade?: boolean;
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
  /**
   * Resolve whether a dead worker's last-claimed issue is still stranded in
   * `running` with no terminal envelope posted (#815). The running-supervisor
   * analogue of boot.ts orphanState, scoped to the crash-reconcile path: the
   * caller already has the issue number from the dead worker's iter-dir state,
   * and only needs to know whether the claim is still open + still `running` +
   * whether an envelope already rode the issue. Best-effort: `ghOk=false` on any
   * gh failure leaves the issue for the boot sweep. Absent → the running
   * supervisor never reconciles a dead worker's claim (back-compat; the
   * boot-time orphan sweep is the only recovery path).
   */
  crashedClaimState?(issue: number): Promise<{
    ghOk: boolean;
    stillRunning: boolean;
    envelopePosted: boolean;
    /** The issue's current labels, when the impl fetched them — enables the
     * death-sweep's atomic transition planning (#2526). */
    labels?: string[];
  }>;
}

/** Per-slot visibility record for non-closed slots in the heartbeat.
 * Closed slots (pid running, not parked) are omitted — only non-closed slots
 * carry a record so the monitor can show per-slot state without parsing logs. */
export interface HeartbeatSlotDetail {
  index: number;
  /** "open" = circuit tripped, awaiting cooldown before next probe
   *  "half-open" = probe worker spawned, waiting for its verdict
   *  "idle-parked" = clean drain with empty queue; auto-unparks on next work */
  status: "open" | "half-open" | "idle-parked";
  /** Epoch when the half-open probe is scheduled (open slots only). Absent for
   * half-open (already probing) and idle-parked (no scheduled retry). */
  retryAt?: number;
}

export interface HeartbeatSlotPid {
  slot: number;
  pid: number;
}

export type TrunkFreshnessStatus = "refreshed" | "failed" | "throttled";

export interface TrunkFreshnessOutcome {
  status: TrunkFreshnessStatus;
  /** Remote ref fetched by the refresh implementation, usually `origin/<trunk>`. */
  remoteRef?: string;
  /** Fleet-owned mirror ref advanced by the refresh implementation. */
  mirrorRef?: string;
  /** Resolved remote tip SHA when the refresh reached the remote. */
  sha?: string;
  /** Epoch seconds of the most recent attempted refresh. */
  refreshedAtEpoch: number;
  /** Next epoch at which another remote fetch is allowed. */
  nextDueEpoch?: number;
  /** Minimum configured interval between remote fetches. */
  intervalS: number;
  /** Short best-effort diagnostic for failed refreshes. */
  message?: string;
}

export type TrunkMirrorRefreshResult =
  Omit<TrunkFreshnessOutcome, "refreshedAtEpoch" | "nextDueEpoch" | "intervalS">;

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
  /** Desired worker count most recently applied from config/directive. */
  target: number;
  /** Runtime shrink behavior most recently applied from config/directive. */
  shrinkMode: ElasticShrinkMode;
  /** Dev bundle version the running supervisor was launched from. */
  bundleVersion?: string;
  readyForAgent: number;
  slotsBusy: number;
  slotsFree: number;
  slotsTotal: number;
  slotsParked: number;
  spawnsThisTick: number;
  /** Recent supervisor churn over a bounded window. Lets read-only surfaces
   * distinguish useful busy slots from fast death/respawn thrash without
   * parsing logs. */
  churn: {
    deaths: number;
    respawns: number;
    windowS: number;
  };
  /** Optional per-drain budget status; absent when no budget is configured. */
  drainBudget?: DrainBudgetStatus;
  /** Latest supervisor tick outcome for the fleet-owned trunk mirror. */
  trunkFreshness?: TrunkFreshnessOutcome;
  /** Per-slot details for non-closed slots. Empty array when all slots are closed. */
  slotDetails: HeartbeatSlotDetail[];
  /** Persisted slot -> worker pid map for supervisor takeover/adoption. */
  slotPids: HeartbeatSlotPid[];
}

export interface FleetHeartbeatEmitResult {
  /** The freshness-critical state file was written successfully. */
  stateWritten: boolean;
  /** The human/debug firehose record was appended successfully. */
  firehoseWritten?: boolean;
  /** Short diagnostic for the most recent state write failure. */
  stateError?: string;
  /** Short diagnostic for the most recent firehose write failure. */
  firehoseError?: string;
}

export type SupervisorEventKind =
  | "supervisor.boot-sweep"
  | "supervisor.tick"
  | "supervisor.dead-slot-reconcile"
  | "supervisor.wake"
  | "supervisor.scale"
  | "supervisor.message";

export type SupervisorEventRecord = Omit<CastleLaneRecord, "at" | "kind"> & {
  kind: SupervisorEventKind;
};

/** The slot's current iteration, resolved from the filesystem. Mirrors the
 * fields reap_stalled_slot pulls out of afk.state.toon. */
export interface IterDirInfo {
  path: string;
  /** .current.number, or null when the worker died before claiming. */
  issue: number | null;
  workerId: string;
  /** Live attempt branch (`afk/{worker}/{issue}-{slug}`), when recoverable. */
  branch?: string;
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
   * Event-driven wake source (#934): resolves the instant a worker's state
   * changes (its afk.state.toon is rewritten / a heartbeat-firehose record is
   * appended), letting the health-check loop react WITHOUT waiting out the full
   * `pollIntervalS` timer. The timer is always retained as the safety-net
   * fallback — whichever fires first wins the per-iteration race. Absent → the
   * loop sleeps the plain poll interval exactly as before (back-compat / no
   * regression when no event lane is wired). The real source is an fs.watch over
   * the worker state tree, built in commands/supervise.ts.
   */
  wake?: WakeSource;
  /**
   * Env view for the bounded stalled re-claim cap (#402). Read by the stall-reaper
   * to resolve `RED_AFK_RETRY_STALLED` via recovery.ts. Defaults to {} (the
   * built-in cap) when absent, so tests can omit it.
   */
  recoveryEnv?: RecoveryEnv;
  /**
   * Optional ADR 0122 heal ledger (castle engine store). When present, the
   * death-sweep consults it before re-queueing a dead worker's issue: the 3rd
   * heal of the same issue in the window quarantines instead of retrying, so
   * an issue that keeps killing workers surfaces as a signal (#2526).
   */
  healLedger?: import("@reddb-io/red-castle/engine").HealLedgerStore;
  /**
   * Optional liveness sink: one line per supervise tick (the CLI appends it to
   * supervisor.log.toonl). Makes a healthy fleet's heartbeat — and a wedged one's
   * silence — observable, so an operator never has to guess fleet state from a
   * stale log. Best-effort; never throws.
   */
  log?(line: string): void;
  /**
   * Structured fleet proof-of-life sink: one record per supervise tick. The CLI
   * writes it to the supervisor firehose and state file. Best-effort; never
   * throws out of the loop.
   */
  emitFleetHeartbeat?(heartbeat: FleetHeartbeat): FleetHeartbeatEmitResult | void | Promise<FleetHeartbeatEmitResult | void>;
  /**
   * Synchronous-with-the-tick repair path for a stale supervisor state writer.
   * Called only after multiple consecutive state-write failures have made the
   * last successful state snapshot older than the live tick loop. The CLI writes
   * the current tick snapshot directly to the state file again and reports
   * whether that repair landed.
   */
  repairFleetHeartbeat?(heartbeat: FleetHeartbeat): FleetHeartbeatEmitResult | void | Promise<FleetHeartbeatEmitResult | void>;
  /**
   * Structured supervisor event sink. The native CLI binds this to the castle
   * supervisor lane writer (`supervisor.log.toonl`). Best-effort; never throws
   * out of the loop.
   */
  emitSupervisorEvent?(record: SupervisorEventRecord): void | Promise<void>;
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
  /**
   * Run the dependency Unblock Sweep on the supervisor tick (#844): list open
   * `blocked:dependency` issues, resolve each `req:*` blocker, and promote only
   * those whose every blocker is CLOSED — returning the promoted issue numbers.
   * Read-mostly and idempotent (re-uses the boot sweep's {@link
   * executeUnblockSweep} core). The tick throttles invocation to
   * `unblockSweepIntervalS`. Best-effort: a throw is swallowed and retried next
   * due tick. Absent in tests / non-fleet contexts → the tick skips the periodic
   * sweep entirely (back-compat; the boot-time sweep still runs).
   */
  unblockSweep?(): Promise<number[]>;
  /**
   * Refresh `origin/<trunk>` into the fleet-owned `red-trunk` mirror. The
   * supervisor owns throttling and observability; the injected runtime owns the
   * concrete git exec.
   */
  refreshTrunkMirror?(): Promise<TrunkMirrorRefreshResult>;
  /**
   * Dispatch a fleet-scoped lifecycle hook at a supervisor checkpoint. Receives
   * the fleet-scoped context (slot, pid, death ring, runner — no issue/worktree
   * fields). Best-effort: throws from the hook executor are caught by the
   * caller and logged, never aborting the fleet. The `on_stall_reap` point has
   * an additional veto semantic: a `vetoed=true` result cancels the hard-reap
   * kill for that pass. Absent → no-op (backward-compatible). (#833)
   */
  dispatchFleetHook?(name: FleetHookName, context: FleetHookContext): Promise<FleetHookDispatchResult>;
  /** Resolve the current local HEAD of an attempt branch. Best-effort: undefined
   * means the contest window cannot observe advancement yet. */
  attemptBranchHead?(branch: string): Promise<string | undefined>;
  /** Runtime elastic fleet request, typically read from the state/afk control
   * file written by `fleet N`. Null means keep the launched config target. */
  resizeRequest?(): Promise<ElasticResizeRequest | null>;
  /** Re-pin real runtime spawn/hook configuration when a live directive changes runner. */
  configureRunner?(runner: string): void | Promise<void>;
}

// ---------- per-slot runtime state ----------
