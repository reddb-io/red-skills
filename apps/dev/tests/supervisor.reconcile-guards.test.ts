import { describe, expect, it, vi } from "vitest";
import {
  NOW,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  tmpdir,
  join,
  buildCrashEnvelope,
  buildDiscardEnvelope,
  buildReaperEnvelope,
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
  stalledVerdict,
  aliveVerdict,
  config,
  liveness,
  makeDeps,
  crashInfo,
  freeSlotState,
} from "./supervisor-test-helpers.js";
import type {
  IterDirInfo,
  ReconcileCandidate,
  SupervisorConfig,
  SupervisorDeps,
  SupervisorState,
  SupervisorLiveness,
  SweepWork,
  ProcessSnapshotEntry,
  LivenessVerdict,
  FakeIo,
} from "./supervisor-test-helpers.js";

describe("guardedTick — per-tick wall-clock ceiling (unwedgeable loop)", () => {
  const never = (): Promise<void> => new Promise<void>(() => {});
  const immediate = (): Promise<void> => Promise.resolve();
  const okResult = { respawned: [1], deaths: [], parked: [], idleParked: [], halfOpened: [], reaped: [], crashReconciled: [], reconciledSlots: [], unblocked: [], retiredSlots: [], runnerChanged: false, stopped: false, queueDepth: 0, abandoned: false };
  const CONTINUE = { respawned: [], deaths: [], parked: [], idleParked: [], halfOpened: [], reaped: [], crashReconciled: [], reconciledSlots: [], unblocked: [], retiredSlots: [], runnerChanged: false, stopped: false, queueDepth: 0, abandoned: true };

  it("returns the tick result when it completes before the ceiling", async () => {
    const logs: string[] = [];
    const r = await guardedTick(async () => okResult, 1000, never, (l) => logs.push(l));
    expect(r).toEqual(okResult);
    expect(logs).toEqual([]); // no timeout / throw log on the happy path
  });

  it("abandons a hung tick after the ceiling and continues (non-stop result)", async () => {
    const logs: string[] = [];
    const r = await guardedTick(() => new Promise<typeof okResult>(() => {}), 5000, immediate, (l) =>
      logs.push(l),
    );
    expect(r).toEqual(CONTINUE);
    expect(r.stopped).toBe(false);
    expect(logs.some((l) => l.includes("exceeded") && l.includes("abandoning"))).toBe(true);
  });

  it("isolates a throwing tick — logged, loop continues", async () => {
    const logs: string[] = [];
    const r = await guardedTick(
      async () => {
        throw new Error("gh boom");
      },
      1000,
      never,
      (l) => logs.push(l),
    );
    expect(r).toEqual(CONTINUE);
    expect(logs.some((l) => l.includes("threw") && l.includes("gh boom"))).toBe(true);
  });
});

describe("idle-drain: exit 0 idle-parks without tripping the circuit breaker", () => {
  it("exit 0 with empty queue idle-parks the slot — no fast-death, no sweep, no spawn", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      readyQueueDepth: vi.fn(async () => 0),
    });
    io.lastExitCode.mockImplementation((slot: number) => (slot === 0 ? 0 : null));
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 5; // would be a fast-death lifetime if counted

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.deaths).toEqual([0]);
    expect(result.idleParked).toEqual([0]);
    expect(result.parked).toEqual([]);
    expect(result.respawned).toEqual([]);
    expect(slot.idleParked).toBe(true);
    expect(slot.parked).toBe(false);
    expect(slot.pid).toBeNull();
    // Death ring untouched — a clean exit is never a fast-death.
    expect(slot.deaths).toEqual([]);
    // No spawn, no discard envelope, no label edits.
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(io.comment).not.toHaveBeenCalled();
    expect(io.editLabels).not.toHaveBeenCalled();
  });

  it("five consecutive exit-0 drains do NOT trip the circuit breaker", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      readyQueueDepth: vi.fn(async () => 0),
    });
    io.lastExitCode.mockReturnValue(0);
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;

    for (let i = 0; i < 5; i++) {
      slot.idleParked = false;
      slot.pid = 1000 + i;
      slot.spawnEpoch = NOW - 5;
      await superviseTick(state, deps, config(), () => false);
    }

    expect(slot.parked).toBe(false);
    expect(slot.idleParked).toBe(true);
    expect(slot.deaths).toEqual([]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });

  it("exit 0 with non-empty queue respawns immediately without counting as fast-death", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      readyQueueDepth: vi.fn(async () => 2),
      spawnSlot: vi.fn(async () => ({ pid: 8888, spawnEpoch: NOW })),
    });
    io.lastExitCode.mockReturnValue(0);
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 5;

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.respawned).toEqual([0]);
    expect(result.idleParked).toEqual([]);
    expect(result.parked).toEqual([]);
    expect(slot.idleParked).toBe(false);
    expect(slot.parked).toBe(false);
    expect(slot.deaths).toEqual([]);
    expect(slot.pid).toBe(8888);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
  });

  it("idle-parked slot respawns when queue refills", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      readyQueueDepth: vi.fn(async () => 3),
      spawnSlot: vi.fn(async () => ({ pid: 7777, spawnEpoch: NOW })),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.idleParked = true;
    slot.pid = null;

    const result = await superviseTick(state, deps, config(), () => false);

    expect(slot.idleParked).toBe(false);
    expect(slot.pid).toBe(7777);
    expect(result.respawned).toEqual([0]);
    expect(result.idleParked).toEqual([]);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
  });

  it("idle-parked slot stays parked when queue is empty", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      readyQueueDepth: vi.fn(async () => 0),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.idleParked = true;
    slot.pid = null;

    const result = await superviseTick(state, deps, config(), () => false);

    expect(slot.idleParked).toBe(true);
    expect(result.respawned).toEqual([]);
    expect(result.idleParked).toEqual([]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });

  it("idle-parked slot is skipped by the stall detector", async () => {
    // A slot that idle-parked has no live process; the stall detector must not
    // try to inspect or reap it (it has no pid and no lane to measure).
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(9999)),
      readyQueueDepth: vi.fn(async () => 0),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.idleParked = true;
    slot.pid = null;
    slot.spawnEpoch = NOW - 9999;

    await pollStallDetector(state, deps, config({ stallThresholdS: 30, stallKillThresholdS: 90 }));

    expect(io.killTree).not.toHaveBeenCalled();
    expect(io.comment).not.toHaveBeenCalled();
    expect(slot.reaped).toBe(false);
  });
});

describe("spawning guard: prevents duplicate spawn when tick is abandoned mid-spawn", () => {
  it("skips a slot with spawning=true to prevent double-spawn", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => false) });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = null;
    slot.spawning = true; // in-flight spawn from an abandoned tick

    const result = await superviseTick(state, deps, config(), () => false);

    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(result.deaths).toEqual([]);
    expect(result.respawned).toEqual([]);
  });

  it("spawning flag is cleared after a successful spawn inside handleDeadSlot", async () => {
    const { deps } = makeDeps({
      isAlive: vi.fn(() => false),
      readyQueueDepth: vi.fn(async () => 0),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 1000; // slow death → respawn

    await handleDeadSlot(0, slot, deps, config());

    expect(slot.spawning).toBe(false);
    expect(slot.pid).not.toBeNull();
  });
});

describe("resolveSupervisorConfig — tick timeout knob", () => {
  it("defaults tickTimeoutS and floors a 0 back to the default (never silently disabled)", () => {
    expect(resolveSupervisorConfig({}).tickTimeoutS).toBe(120);
    expect(resolveSupervisorConfig({ RED_AFK_TICK_TIMEOUT_S: "0" }).tickTimeoutS).toBe(120);
    expect(resolveSupervisorConfig({ RED_AFK_TICK_TIMEOUT_S: "45" }).tickTimeoutS).toBe(45);
    expect(resolveSupervisorConfig({ RED_AFK_TICK_TIMEOUT_S: "abc" }).tickTimeoutS).toBe(120);
  });
});

describe("resolveSupervisorConfig — supervisor stale knob (#407)", () => {
  it("defaults supervisorStaleS and floors a 0/garbage back to the default", () => {
    expect(resolveSupervisorConfig({}).supervisorStaleS).toBe(300);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_STALE_S: "0" }).supervisorStaleS).toBe(300);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_STALE_S: "900" }).supervisorStaleS).toBe(900);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_STALE_S: "abc" }).supervisorStaleS).toBe(300);
  });
});

describe("resolveSupervisorConfig — dead-supervisor crash-loop knobs (#1097)", () => {
  it("defaults the max-restarts bound and floors a 0/garbage back to the default", () => {
    expect(resolveSupervisorConfig({}).supervisorMaxRestarts).toBe(5);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_MAX_RESTARTS: "0" }).supervisorMaxRestarts).toBe(5);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_MAX_RESTARTS: "3" }).supervisorMaxRestarts).toBe(3);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_MAX_RESTARTS: "abc" }).supervisorMaxRestarts).toBe(5);
  });

  it("defaults the restart window and floors a 0/garbage back to the default", () => {
    expect(resolveSupervisorConfig({}).supervisorRestartWindowS).toBe(300);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_RESTART_WINDOW_S: "0" }).supervisorRestartWindowS).toBe(300);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_RESTART_WINDOW_S: "600" }).supervisorRestartWindowS).toBe(600);
    expect(resolveSupervisorConfig({ RED_AFK_SUPERVISOR_RESTART_WINDOW_S: "x" }).supervisorRestartWindowS).toBe(300);
  });
});

describe("dispatchReconcileIfPossible — dispatch decision and slot accounting", () => {
  const CANDIDATE: ReconcileCandidate = { issue: 42, branch: "afk/wAAAA/42-some-fix" };

  it("is a no-op when spawnReconcileWorker is absent", async () => {
    const { deps, io } = makeDeps();
    // Remove the optional method.
    delete (deps.proc as Partial<typeof deps.proc>).spawnReconcileWorker;
    io.findReconcileCandidate.mockResolvedValueOnce(CANDIDATE);

    const state = freeSlotState();
    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBeNull();
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });

  it("is a no-op when findReconcileCandidate is absent", async () => {
    const { deps, io } = makeDeps();
    delete (deps.gh as Partial<typeof deps.gh>).findReconcileCandidate;

    const state = freeSlotState();
    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBeNull();
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });

  it("returns null when no free slot exists (all slots have a live pid)", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockResolvedValueOnce(CANDIDATE);

    const state = initSupervisorState(2);
    // Both slots occupied.
    state.slots[0]!.pid = 1001;
    state.slots[1]!.pid = 1002;

    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBeNull();
    expect(io.findReconcileCandidate).not.toHaveBeenCalled(); // slot check first
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });

  it("returns null when findReconcileCandidate returns null (no eligible candidate)", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockResolvedValueOnce(null);

    const state = freeSlotState();
    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBeNull();
    expect(io.findReconcileCandidate).toHaveBeenCalledOnce();
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });

  it("returns null when findReconcileCandidate throws (best-effort: swallowed)", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockRejectedValueOnce(new Error("gh timeout"));

    const state = freeSlotState();
    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBeNull();
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });

  it("dispatches a reconcile worker into the free slot when a candidate is found", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockResolvedValueOnce(CANDIDATE);
    io.spawnReconcileWorker.mockResolvedValueOnce({ pid: 9999, spawnEpoch: NOW });

    const state = freeSlotState();
    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBe(0); // slot 0 received the worker
    expect(io.findReconcileCandidate).toHaveBeenCalledOnce();
    expect(io.spawnReconcileWorker).toHaveBeenCalledOnce();
    expect(io.spawnReconcileWorker).toHaveBeenCalledWith(0, CANDIDATE);
  });

  it("updates the slot state after dispatch: pid set, stale flags cleared", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockResolvedValueOnce(CANDIDATE);
    io.spawnReconcileWorker.mockResolvedValueOnce({ pid: 9999, spawnEpoch: NOW + 5 });

    const state = freeSlotState();
    // Pre-set stale stall flags to verify they are cleared.
    state.slots[0]!.stalled = true;
    state.slots[0]!.stallSinceEpoch = NOW - 100;
    state.slots[0]!.reaped = true;

    await dispatchReconcileIfPossible(state, deps);

    const slot = state.slots[0]!;
    expect(slot.pid).toBe(9999);
    expect(slot.spawnEpoch).toBe(NOW + 5);
    expect(slot.stalled).toBe(false);
    expect(slot.stallSinceEpoch).toBe(0);
    expect(slot.reaped).toBe(false);
  });

  it("picks the first free slot when multiple slots exist", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockResolvedValueOnce(CANDIDATE);
    io.spawnReconcileWorker.mockResolvedValueOnce({ pid: 7777, spawnEpoch: NOW });

    const state = initSupervisorState(3);
    // Slots 0 and 2 are busy; slot 1 is free.
    state.slots[0]!.pid = 1001;
    state.slots[1]!.pid = null; // free
    state.slots[2]!.pid = 1003;

    const result = await dispatchReconcileIfPossible(state, deps);

    expect(result).toBe(1);
    expect(io.spawnReconcileWorker).toHaveBeenCalledWith(1, CANDIDATE);
    expect(state.slots[1]!.pid).toBe(7777);
  });

  it("skips parked slots when looking for a free slot", async () => {
    const { deps, io } = makeDeps();
    io.findReconcileCandidate.mockResolvedValueOnce(CANDIDATE);

    const state = initSupervisorState(2);
    // Slot 0 is parked (circuit-tripped); slot 1 has a live worker.
    state.slots[0]!.parked = true;
    state.slots[0]!.pid = null;
    state.slots[1]!.pid = 1002;

    const result = await dispatchReconcileIfPossible(state, deps);

    // No free non-parked slot → no dispatch.
    expect(result).toBeNull();
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });
});

describe("superviseTick — reconciledSlots accounting (#562)", () => {
  // Stall-reap setup: slot has a live pid, stalled past the kill threshold, and
  // an empty inspectTree so decideReaperSignal returns "kill". After the stall-
  // reaper fires (step 3 of superviseTick), the slot's pid is null → free for
  // dispatchReconcileIfPossible (step 4) to fill with a reconcile worker.
  function stalledSlotDeps(candidate: ReconcileCandidate | null) {
    return makeDeps({
      isAlive: vi.fn(() => true), // pid alive so step 2 never respawns
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(1000)), // agent lane silent for 1000s
      now: vi.fn(() => NOW),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []), // no active → "kill"
      resolveIterDir: vi.fn(() => null),
      findReconcileCandidate: vi.fn(async (): Promise<ReconcileCandidate | null> => candidate),
    });
  }

  it("dispatches into a stall-reaped slot when a candidate is found", async () => {
    const CANDIDATE: ReconcileCandidate = { issue: 77, branch: "afk/wBBBB/77-fix" };
    const { deps, io } = stalledSlotDeps(CANDIDATE);
    io.spawnReconcileWorker.mockResolvedValueOnce({ pid: 8888, spawnEpoch: NOW });

    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;
    state.slots[0]!.stalled = true;
    state.slots[0]!.stallSinceEpoch = NOW - 1000; // 1000s > stallKillThresholdS(90)

    const result = await superviseTick(
      state, deps, config({ target: 1, stallThresholdS: 30, stallKillThresholdS: 90 }), () => false,
    );

    expect(result.reaped).toEqual([0]);
    expect(result.reconciledSlots).toEqual([0]);
    expect(io.spawnReconcileWorker).toHaveBeenCalledOnce();
    expect(io.spawnReconcileWorker).toHaveBeenCalledWith(0, CANDIDATE);
  });

  it("reconciledSlots is empty when no candidate is found after a stall-reap", async () => {
    const { deps, io } = stalledSlotDeps(null);

    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;
    state.slots[0]!.stalled = true;
    state.slots[0]!.stallSinceEpoch = NOW - 1000;

    const result = await superviseTick(
      state, deps, config({ target: 1, stallThresholdS: 30, stallKillThresholdS: 90 }), () => false,
    );

    expect(result.reaped).toEqual([0]);
    expect(result.reconciledSlots).toEqual([]);
    expect(io.spawnReconcileWorker).not.toHaveBeenCalled();
  });
});

describe("superviseTick — periodic dependency Unblock Sweep (#844)", () => {
  it("runs the sweep on the first tick (lastUnblockSweepEpoch=0) and records promotions", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true), // slot occupied: no spawn/respawn this tick
      unblockSweep: vi.fn(async (): Promise<number[]> => [42]),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;

    const result = await superviseTick(state, deps, config({ unblockSweepIntervalS: 60 }), () => false);

    expect(io.unblockSweep).toHaveBeenCalledOnce();
    expect(result.unblocked).toEqual([42]);
    expect(state.lastUnblockSweepEpoch).toBe(NOW);
  });

  it("throttles: a second tick inside the interval does NOT re-run the sweep", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      now: vi.fn(() => NOW),
      unblockSweep: vi.fn(async (): Promise<number[]> => []),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;
    state.lastUnblockSweepEpoch = NOW - 30; // 30s ago, interval is 60s → not due

    const result = await superviseTick(state, deps, config({ unblockSweepIntervalS: 60 }), () => false);

    expect(io.unblockSweep).not.toHaveBeenCalled();
    expect(result.unblocked).toEqual([]);
    expect(state.lastUnblockSweepEpoch).toBe(NOW - 30); // unchanged
  });

  it("re-runs once the interval has elapsed", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      now: vi.fn(() => NOW),
      unblockSweep: vi.fn(async (): Promise<number[]> => [7]),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;
    state.lastUnblockSweepEpoch = NOW - 60; // exactly the interval → due

    const result = await superviseTick(state, deps, config({ unblockSweepIntervalS: 60 }), () => false);

    expect(io.unblockSweep).toHaveBeenCalledOnce();
    expect(result.unblocked).toEqual([7]);
    expect(state.lastUnblockSweepEpoch).toBe(NOW);
  });

  it("promotes an unblockable dependent with an idle, all-blocked queue and no spawn", async () => {
    // ready:0 (empty queue), every slot occupied → no respawn, no idle un-park.
    // The only mutation this tick is the periodic sweep promoting the dependent.
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      readyQueueDepth: vi.fn(async () => 0),
      unblockSweep: vi.fn(async (): Promise<number[]> => [101]),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;

    const result = await superviseTick(state, deps, config({ unblockSweepIntervalS: 60 }), () => false);

    expect(result.respawned).toEqual([]);
    expect(result.unblocked).toEqual([101]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });

  it("is best-effort: a throwing sweep leaves unblocked=[] and still stamps so it retries next interval", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      unblockSweep: vi.fn(async (): Promise<number[]> => {
        throw new Error("gh exploded");
      }),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;

    const result = await superviseTick(state, deps, config({ unblockSweepIntervalS: 60 }), () => false);

    expect(io.unblockSweep).toHaveBeenCalledOnce();
    expect(result.unblocked).toEqual([]);
    expect(state.lastUnblockSweepEpoch).toBe(NOW); // stamped despite the throw
  });

  it("is back-compat: a tick with no unblockSweep wired completes without sweeping", async () => {
    const { deps } = makeDeps({
      isAlive: vi.fn(() => true),
      unblockSweep: undefined,
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.slots[0]!.spawnEpoch = NOW - 3600;

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.unblocked).toEqual([]);
    expect(state.lastUnblockSweepEpoch).toBe(0); // never stamped
  });
});
