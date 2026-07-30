import { vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCrashEnvelope,
  buildDiscardEnvelope,
  buildReaperEnvelope,
  buildWallClockCapEnvelope,
  adoptPersistedSlotPids,
  decideCrashReconcile,
  dispatchReconcileIfPossible,
  reconcileDeadWorkerClaim,
  freshSlot,
  handleDeadSlot,
  initSupervisorState,
  pollStallDetector,
  resolveReapContest,
  recordDeath,
  resolveSupervisorConfig,
  runSupervisor,
  sweepParkedSlot,
  superviseTick,
  validateStallThresholds,
  validateSupervisorStaleThreshold,
  validateSupervisorProgressThreshold,
  classifySupervisor,
  evaluateDrainBudget,
  evaluateValidationAdmission,
  guardedTick,
  type IterDirInfo,
  type ReconcileCandidate,
  type SupervisorConfig,
  type SupervisorDeps,
  type SupervisorState,
  type SupervisorLiveness,
  type SweepWork,
} from "../src/core/supervisor.js";
import { parkedSlotWorkFor, slotLogDir, slotLogPath } from "../src/runtime/supervisor-fs.js";
import type { ProcessSnapshotEntry } from "../src/core/reaper-signal.js";
import type { LivenessVerdict } from "@reddb-io/red-castle";

export {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  tmpdir,
  join,
  buildCrashEnvelope,
  buildDiscardEnvelope,
  buildReaperEnvelope,
  buildWallClockCapEnvelope,
  adoptPersistedSlotPids,
  decideCrashReconcile,
  dispatchReconcileIfPossible,
  reconcileDeadWorkerClaim,
  freshSlot,
  handleDeadSlot,
  initSupervisorState,
  pollStallDetector,
  resolveReapContest,
  recordDeath,
  resolveSupervisorConfig,
  runSupervisor,
  sweepParkedSlot,
  superviseTick,
  validateStallThresholds,
  validateSupervisorStaleThreshold,
  validateSupervisorProgressThreshold,
  classifySupervisor,
  evaluateDrainBudget,
  evaluateValidationAdmission,
  guardedTick,
  parkedSlotWorkFor,
  slotLogDir,
  slotLogPath,
};

export type {
  IterDirInfo,
  ReconcileCandidate,
  SupervisorConfig,
  SupervisorDeps,
  SupervisorState,
  SupervisorLiveness,
  SweepWork,
  ProcessSnapshotEntry,
  LivenessVerdict,
};

export const NOW = 1700000000;

/** Build a stalled LivenessVerdict with a given lane age in seconds. */
export function stalledVerdict(laneAgeS: number): LivenessVerdict {
  return {
    status: "stalled",
    laneFresh: false,
    laneAgeMs: laneAgeS * 1000,
    crossCheckArmed: true,
    liveDescendants: false,
    reason: "lane idle and no live agent descendants",
  };
}

/** Build a wall-clock-ceiling LivenessVerdict (#2286): `capped` — NOT stalled
 * (#2701) — because the lane is fresh and the attempt has simply held its issue
 * past the per-issue ceiling. */
export function wallClockVerdict(issueAgeS: number): LivenessVerdict {
  return {
    status: "capped",
    laneFresh: true,
    laneAgeMs: 1_000,
    crossCheckArmed: true,
    issueAgeMs: issueAgeS * 1000,
    wallClockExceeded: true,
    reason: "issue wall-clock ceiling exceeded — activity-independent",
  };
}

/** Build an alive LivenessVerdict (lane fresh). */
export function aliveVerdict(): LivenessVerdict {
  return {
    status: "alive",
    laneFresh: true,
    laneAgeMs: 1000,
    crossCheckArmed: true,
    reason: "lane fresh",
  };
}

export function config(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    target: 1,
    fastDeathThresholdS: 30,
    circuitK: 5,
    circuitWindowS: 90,
    stallThresholdS: 30,
    stallKillThresholdS: 90,
    issueWallClockMaxS: 2700,
    runner: "claude",
    pollIntervalS: 15,
    eventFallbackS: 60,
    tickTimeoutS: 120,
    supervisorStaleS: 300,
    progressStaleS: 900,
    halfOpenBaseS: 60,
    halfOpenCapS: 3600,
    unblockSweepIntervalS: 60,
    trunkFreshnessIntervalS: 60,
    supervisorMaxRestarts: 5,
    supervisorRestartWindowS: 300,
    reapContestWindowS: 30,
    shrinkMode: "drain-then-retire",
    // Unlimited by default, exactly like an unconfigured repo: a test that
    // exercises a budget sets it explicitly.
    workerBudgets: {},
    ...over,
  };
}

export function liveness(over: Partial<SupervisorLiveness> = {}): SupervisorLiveness {
  return {
    pid: null,
    pidAlive: false,
    lastHeartbeatEpoch: null,
    lastProgressEpoch: null,
    slotsBusy: 0,
    ...over,
  };
}

export interface FakeIo {
  spawnSlot: ReturnType<typeof vi.fn>;
  spawnReconcileWorker: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  requestSlotRetire: ReturnType<typeof vi.fn>;
  inspectTree: ReturnType<typeof vi.fn>;
  sampleTreeRssMb: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  lastExitCode: ReturnType<typeof vi.fn>;
  workerLivenessVerdict: ReturnType<typeof vi.fn>;
  resolveIterDir: ReturnType<typeof vi.fn>;
  teardownIterDir: ReturnType<typeof vi.fn>;
  parkedSlotWork: ReturnType<typeof vi.fn>;
  removeDir: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
  editLabels: ReturnType<typeof vi.fn>;
  ensureRunnerErrorLabel: ReturnType<typeof vi.fn>;
  ensureLabel: ReturnType<typeof vi.fn>;
  readyQueueDepth: ReturnType<typeof vi.fn>;
  findReconcileCandidate: ReturnType<typeof vi.fn>;
  crashedClaimState: ReturnType<typeof vi.fn>;
  emitFleetHeartbeat: ReturnType<typeof vi.fn>;
  repairFleetHeartbeat: ReturnType<typeof vi.fn>;
  unblockSweep: ReturnType<typeof vi.fn>;
  refreshTrunkMirror: ReturnType<typeof vi.fn>;
  fleetCostUsd: ReturnType<typeof vi.fn>;
  resizeRequest: ReturnType<typeof vi.fn>;
  attemptBranchHead: ReturnType<typeof vi.fn>;
  publishAttemptBranch: ReturnType<typeof vi.fn>;
  findAttemptPullRequest: ReturnType<typeof vi.fn>;
  configureRunner: ReturnType<typeof vi.fn>;
  emitSupervisorEvent: ReturnType<typeof vi.fn>;
  bootSweeps: ReturnType<typeof vi.fn>;
  logLines: string[];
  now: ReturnType<typeof vi.fn>;
}

export function makeDeps(over: Partial<Record<keyof FakeIo, unknown>> = {}): {
  deps: SupervisorDeps;
  io: FakeIo;
} {
  let nextPid = 1000;
  const io: FakeIo = {
    spawnSlot: vi.fn(async () => ({ pid: ++nextPid, spawnEpoch: NOW })),
    spawnReconcileWorker: vi.fn(async () => ({ pid: ++nextPid, spawnEpoch: NOW })),
    isAlive: vi.fn(() => true),
    killTree: vi.fn(async () => {}),
    requestSlotRetire: vi.fn(async () => {}),
    inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
    // Default: the resident measures no memory (an unsampled fleet), so the
    // attempt record simply omits peak RSS.
    sampleTreeRssMb: vi.fn((_pids: readonly number[]) => new Map<number, number>()),
    // Resolve on a macrotask (not immediately): runSupervisor wraps each tick in
    // guardedTick, which RACES the tick against `sleep(ceiling)`. An
    // immediately-resolving sleep makes the ceiling win every race, so the real
    // `{stopped:true}` is discarded and the `for(;;)` loop spins forever (→ OOM,
    // #446). A `setTimeout(…, 0)` resolves after the tick's microtasks, so the
    // tick wins and `stopped` propagates — matching production, where `sleep` is a
    // real timer that never beats a sub-second tick.
    sleep: vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0))),
    // Default: exit code unknown (null) → treated as non-clean → circuit-breaker path.
    lastExitCode: vi.fn((_slot: number) => null as number | null),
    workerLivenessVerdict: vi.fn((): LivenessVerdict | null => null),
    resolveIterDir: vi.fn((): IterDirInfo | null => null),
    teardownIterDir: vi.fn(async () => {}),
    parkedSlotWork: vi.fn(
      (): SweepWork => ({ workers: [], supervisorLogPath: ".red/tmp/afk-supervisor.log" }),
    ),
    removeDir: vi.fn(async () => {}),
    comment: vi.fn(async () => {}),
    editLabels: vi.fn(async () => {}),
    ensureRunnerErrorLabel: vi.fn(async () => {}),
    ensureLabel: vi.fn(async () => {}),
    readyQueueDepth: vi.fn(async () => 0),
    findReconcileCandidate: vi.fn(async (): Promise<ReconcileCandidate | null> => null),
    // Default: no stranded claim → reconcile is a no-op (existing tests unaffected).
    crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: false, envelopePosted: false })),
    emitFleetHeartbeat: vi.fn(async () => {}),
    repairFleetHeartbeat: vi.fn(async () => ({ stateWritten: true })),
    unblockSweep: vi.fn(async (): Promise<number[]> => []),
    refreshTrunkMirror: vi.fn(async () => ({
      status: "refreshed",
      remoteRef: "origin/main",
      mirrorRef: "red-trunk",
      sha: "abc123",
    })),
    fleetCostUsd: vi.fn(() => 0),
    resizeRequest: vi.fn(async () => null),
    attemptBranchHead: vi.fn(async () => undefined as string | undefined),
    publishAttemptBranch: vi.fn(async (_branch: string) => true),
    findAttemptPullRequest: vi.fn(async (_issue: number) => null as number | null),
    configureRunner: vi.fn(async () => {}),
    emitSupervisorEvent: vi.fn(async () => {}),
    bootSweeps: vi.fn(async () => {}),
    logLines: [],
    now: vi.fn(() => NOW),
    ...(over as Partial<FakeIo>),
  };
  const deps: SupervisorDeps = {
    proc: {
      spawnSlot: io.spawnSlot,
      spawnReconcileWorker: io.spawnReconcileWorker,
      isAlive: io.isAlive,
      lastExitCode: io.lastExitCode,
      killTree: io.killTree,
      requestSlotRetire: io.requestSlotRetire,
      inspectTree: io.inspectTree,
      sampleTreeRssMb: io.sampleTreeRssMb,
      sleep: io.sleep,
    },
    fs: {
      workerLivenessVerdict: io.workerLivenessVerdict,
      resolveIterDir: io.resolveIterDir,
      teardownIterDir: io.teardownIterDir,
      parkedSlotWork: io.parkedSlotWork,
      removeDir: io.removeDir,
      fleetCostUsd: io.fleetCostUsd,
    },
    gh: {
      comment: io.comment,
      editLabels: io.editLabels,
      ensureRunnerErrorLabel: io.ensureRunnerErrorLabel,
      ensureLabel: io.ensureLabel,
      readyQueueDepth: io.readyQueueDepth,
      findReconcileCandidate: io.findReconcileCandidate,
      crashedClaimState: io.crashedClaimState,
      findAttemptPullRequest: io.findAttemptPullRequest,
    },
    now: io.now,
    log: (line) => {
      io.logLines.push(line);
    },
    emitFleetHeartbeat: io.emitFleetHeartbeat,
    repairFleetHeartbeat: io.repairFleetHeartbeat,
    unblockSweep: io.unblockSweep,
    refreshTrunkMirror: io.refreshTrunkMirror,
    attemptBranchHead: io.attemptBranchHead,
    publishAttemptBranch: io.publishAttemptBranch,
    configureRunner: io.configureRunner,
    resizeRequest: io.resizeRequest,
    emitSupervisorEvent: io.emitSupervisorEvent,
    bootSweeps: io.bootSweeps,
  };
  return { deps, io };
}

// ---------- threshold validation ----------



// ---------- validateSupervisorStaleThreshold (#407) ----------



// ---------- validateSupervisorProgressThreshold (#579) ----------



// ---------- classifySupervisor (#407 + #579 quiescence detector, pure) ----------



// ---------- resolveSupervisorConfig ----------







// ---------- abandoned tick / lastProgressEpoch (#579) ----------





// ---------- pollStallDetector: liveness-evaluator stall detection ----------

// ---------- circuit breaker (pure) ----------



// ---------- circuit trip → park + sweep ----------



// ---------- circuit trip integration (real FS, native fleet path) ----------

/**
 * Integration test: the full path from circuit trip → sweepParkedSlot →
 * parkedSlotWorkFor (real filesystem) → label restore. Uses no fake for
 * parkedSlotWork so it exercises the actual slot-log boot-stamp resolution
 * that the native fleet depends on.
 *
 * Covers acceptance criterion: "The parked-slot work resolution is exercised
 * by an integration test over the REAL path (current coverage injects a fake
 * and never runs it)."
 */


// ---------- stall reaper gating ----------



// ---------- AC3: evaluator cross-check guards the kill ----------



// ---------- tick: respawn dead slot ----------





// ---------- crash reconcile (#815, ADR 0071 Pattern 5) ----------

export function crashInfo(over: Partial<IterDirInfo> = {}): IterDirInfo {
  return {
    path: "/tmp/workers/w27CZ/807-a1",
    issue: 807,
    workerId: "w27CZ",
    logTail: "agent finished after 1 iteration\nfeedback gate: turbo run test…",
    notes: "",
    durationS: 1200,
    attempt: 1,
    ...over,
  };
}







// ---------- runSupervisor end-to-end shape ----------



// ---------- envelope builders ----------





// ---------- idle-drain: exit 0 idle-parks and un-parks on queue refill (#578) ----------



// ---------- spawning guard: prevents duplicate spawn on abandoned tick (#578) ----------









// ---------- dispatchReconcileIfPossible (#562) ----------

/** Build a SupervisorState with slot 0 free (pid null, not parked). */
export function freeSlotState(): SupervisorState {
  const state = initSupervisorState(1);
  state.slots[0] = freshSlot(); // pid: null, parked: false
  return state;
}





// ---------- periodic dependency Unblock Sweep on the tick (#844) ----------



// ---------- continuous trunk freshness tick (#2074) ----------





// ---------- half-open circuit breaker (#628) ----------
