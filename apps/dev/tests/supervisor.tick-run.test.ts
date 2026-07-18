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

describe("pollStallDetector — live descendants prevent kill (AC3 / ADR 0083)", () => {
  // Pre-set the slot as stalled past the kill threshold so each test reaches the
  // kill-gate without needing to test full stall detection.
  function stalledSlot() {
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 4242;
    slot.spawnEpoch = NOW - 9999;
    slot.stalled = true;
    slot.stallSinceEpoch = NOW - 120; // 120s > stallKillThresholdS(90)
    return state;
  }

  it("stale lane + no live descendants → kill", async () => {
    const { deps, io } = makeDeps({
      // Evaluator: stalled (lane idle, no live descendants)
      workerLivenessVerdict: vi.fn((): LivenessVerdict => ({
        status: "stalled",
        laneFresh: false,
        laneAgeMs: 120_000,
        crossCheckArmed: true,
        liveDescendants: false,
        reason: "lane idle and no live agent descendants",
      })),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/42-a1",
          issue: 42,
          workerId: "wTEST",
          logTail: "stalled",
          notes: "",
          durationS: 120,
          attempt: 1,
        }),
      ),
    });
    const state = stalledSlot();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
  });

  it("live agent descendants → no kill even with a stale lane", async () => {
    const { deps, io } = makeDeps({
      // Evaluator: alive via cross-check (wedged substrate but agent still running)
      workerLivenessVerdict: vi.fn((): LivenessVerdict => ({
        status: "alive",
        laneFresh: false,
        laneAgeMs: 120_000,
        crossCheckArmed: true,
        liveDescendants: true,
        reason: "lane idle but live agent descendants",
      })),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
    });
    const state = stalledSlot();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([]);
    expect(io.killTree).not.toHaveBeenCalled();
  });
});

describe("superviseTick", () => {
  it("respawns a dead slot to target", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false), // the slot's worker is dead
      now: vi.fn(() => NOW),
      // A slow death (lifetime > fastDeathThreshold) → respawn, no park.
      spawnSlot: vi.fn(async () => ({ pid: 9001, spawnEpoch: NOW })),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 1000; // long-lived → slow death

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.deaths).toEqual([0]);
    expect(result.respawned).toEqual([0]);
    expect(result.parked).toEqual([]);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
    expect(slot.pid).toBe(9001);
    expect(slot.parked).toBe(false);
  });

  it("leaves a live slot alone", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 5;

    const result = await superviseTick(state, deps, config(), () => false);
    expect(result.deaths).toEqual([]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });

  it("stop-file → terminate all live workers and report stopped", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(2);
    state.slots[0]!.pid = 100;
    state.slots[1]!.pid = 200;

    const result = await superviseTick(state, deps, config({ target: 2 }), () => true);

    expect(result.stopped).toBe(true);
    expect(io.killTree).toHaveBeenCalledWith(100);
    expect(io.killTree).toHaveBeenCalledWith(200);
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });
});

describe("superviseTick — elastic fleet resize (#1913)", () => {
  it("grows at runtime by adding slots and spawning them immediately", async () => {
    const { deps, io } = makeDeps({
      spawnSlot: vi.fn(async (slot: number) => ({ pid: 9000 + slot, spawnEpoch: NOW })),
      resizeRequest: vi.fn(async () => ({ target: 3, shrinkMode: "drain-then-retire" })),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 5000;
    state.slots[0]!.spawnEpoch = NOW - 30;

    const result = await superviseTick(state, deps, config({ target: 1 }), () => false);

    expect(state.slots).toHaveLength(3);
    expect(io.spawnSlot).toHaveBeenCalledWith(1);
    expect(io.spawnSlot).toHaveBeenCalledWith(2);
    expect(state.slots[1]!.pid).toBe(9001);
    expect(state.slots[2]!.pid).toBe(9002);
    expect(result.respawned).toEqual([1, 2]);
  });

  it("shrinks with hard-kill by killing trailing slots, reconciling claims, and removing them immediately", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      resizeRequest: vi.fn(async () => ({ target: 1, shrinkMode: "hard-kill" })),
      resolveIterDir: vi.fn((slot: number): IterDirInfo | null =>
        slot === 2 ? crashInfo({ issue: 902, workerId: "wSHRINK" }) : null,
      ),
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: true, envelopePosted: true })),
    });
    deps.recoveryEnv = { RED_AFK_RETRY_CRASH: "2" };
    const state = initSupervisorState(3);
    state.slots[0]!.pid = 5000;
    state.slots[1]!.pid = 5001;
    state.slots[2]!.pid = 5002;

    const result = await superviseTick(state, deps, config({ target: 3 }), () => false);

    expect(io.killTree).toHaveBeenCalledWith(5002);
    expect(io.killTree).toHaveBeenCalledWith(5001);
    expect(io.editLabels).toHaveBeenCalledWith(902, ["ready-for-agent"], ["running"]);
    expect(state.slots).toHaveLength(1);
    expect(result.retiredSlots).toEqual([2, 1]);
  });

  it("shrinks with drain-then-retire by marking live trailing slots and removing them only after exit", async () => {
    const live = new Set([5000, 5001]);
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => live.has(pid)),
      resizeRequest: vi.fn(async () => ({ target: 1, shrinkMode: "drain-then-retire" })),
    });
    const state = initSupervisorState(2);
    state.slots[0]!.pid = 5000;
    state.slots[1]!.pid = 5001;

    let result = await superviseTick(state, deps, config({ target: 2 }), () => false);

    expect(state.slots).toHaveLength(2);
    expect(state.slots[1]!.retiring).toBe(true);
    expect(io.requestSlotRetire).toHaveBeenCalledWith(1, 5001);
    expect(io.killTree).not.toHaveBeenCalled();
    expect(result.retiredSlots).toEqual([]);

    live.delete(5001);
    io.lastExitCode.mockReturnValue(0);
    result = await superviseTick(state, deps, config({ target: 2 }), () => false);

    expect(state.slots).toHaveLength(1);
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(result.retiredSlots).toEqual([1]);
  });

  it("switches runner at runtime by retiring every live slot before respawning on the new runner", async () => {
    const live = new Set([5000, 5001]);
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => live.has(pid)),
      resizeRequest: vi.fn(async () => ({ target: 2, runner: "codex", shrinkMode: "drain-then-retire" })),
      spawnSlot: vi.fn(async (slot: number) => ({ pid: 9000 + slot, spawnEpoch: NOW })),
    });
    const cfg = config({ target: 2, runner: "claude" });
    const state = initSupervisorState(2);
    state.slots[0]!.pid = 5000;
    state.slots[1]!.pid = 5001;

    let result = await superviseTick(state, deps, cfg, () => false);

    expect(cfg.runner).toBe("codex");
    expect(io.configureRunner).toHaveBeenCalledWith("codex");
    expect(state.slots).toHaveLength(2);
    expect(state.slots.every((slot) => slot.retiring)).toBe(true);
    expect(io.requestSlotRetire).toHaveBeenCalledWith(0, 5000);
    expect(io.requestSlotRetire).toHaveBeenCalledWith(1, 5001);
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(result.runnerChanged).toBe(true);

    live.clear();
    io.lastExitCode.mockReturnValue(0);
    result = await superviseTick(state, deps, cfg, () => false);

    expect(state.slots).toHaveLength(0);
    expect(result.retiredSlots).toEqual([1, 0]);

    result = await superviseTick(state, deps, cfg, () => false);

    expect(state.slots).toHaveLength(2);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
    expect(io.spawnSlot).toHaveBeenCalledWith(1);
    expect(result.respawned).toEqual([0, 1]);
  });

  it("treats an unchanged runner directive as a no-op", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      resizeRequest: vi.fn(async () => ({ target: 2, runner: "claude", shrinkMode: "drain-then-retire" })),
    });
    const cfg = config({ target: 2, runner: "claude" });
    const state = initSupervisorState(2);
    state.slots[0]!.pid = 5000;
    state.slots[1]!.pid = 5001;

    const result = await superviseTick(state, deps, cfg, () => false);

    expect(io.configureRunner).not.toHaveBeenCalled();
    expect(io.requestSlotRetire).not.toHaveBeenCalled();
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(state.slots.every((slot) => !slot.retiring)).toBe(true);
    expect(result.runnerChanged).toBe(false);
  });
});

describe("decideCrashReconcile", () => {
  it("reconciles a still-running claim with a real issue", () => {
    expect(decideCrashReconcile({ issue: 807, ghOk: true, stillRunning: true })).toBe(true);
  });
  it("skips a pre-claim death (null issue)", () => {
    expect(decideCrashReconcile({ issue: null, ghOk: true, stillRunning: true })).toBe(false);
  });
  it("skips a failed gh lookup", () => {
    expect(decideCrashReconcile({ issue: 807, ghOk: false, stillRunning: true })).toBe(false);
  });
  it("skips an issue no longer running (worker completed)", () => {
    expect(decideCrashReconcile({ issue: 807, ghOk: true, stillRunning: false })).toBe(false);
  });
});

describe("reconcileDeadWorkerClaim", () => {
  it("posts a no-sentinel envelope and re-queues a stranded running issue (under cap)", async () => {
    const { deps, io } = makeDeps({
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: true, envelopePosted: false })),
    });
    // Raise the crashed cap to 2 so attempt 1 (1 < 2) is under the cap → retry.
    deps.recoveryEnv = { RED_AFK_RETRY_CRASH: "2" };

    const issue = await reconcileDeadWorkerClaim(crashInfo(), deps);

    expect(issue).toBe(807);
    // No-sentinel envelope carrying the afk.log tail.
    expect(io.comment).toHaveBeenCalledTimes(1);
    const body = io.comment.mock.calls[0]![1] as string;
    expect(body).toContain('data-attempt-status="no-sentinel"');
    expect(body).toContain("agent finished after 1 iteration");
    // running → ready-for-agent CLEAN (no blocked label rides along).
    expect(io.editLabels).toHaveBeenCalledWith(807, ["ready-for-agent"], ["running"]);
  });

  it("escalates to ready-for-human with blocked:crashed once the cap is exhausted", async () => {
    const { deps, io } = makeDeps({
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: true, envelopePosted: false })),
    });
    // Default crashed cap is 1; attempt 1 is at the cap → escalate.
    const issue = await reconcileDeadWorkerClaim(crashInfo({ attempt: 1 }), deps);

    expect(issue).toBe(807);
    expect(io.ensureLabel).toHaveBeenCalledWith("blocked:crashed");
    expect(io.editLabels).toHaveBeenCalledWith(
      807,
      ["ready-for-human", "blocked:crashed"],
      ["running", "ready-for-agent"],
    );
  });

  it("does not re-post the envelope when one already rode the issue", async () => {
    const { deps, io } = makeDeps({
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: true, envelopePosted: true })),
    });
    deps.recoveryEnv = { RED_AFK_RETRY_CRASH: "2" };

    await reconcileDeadWorkerClaim(crashInfo(), deps);
    expect(io.comment).not.toHaveBeenCalled();
    expect(io.editLabels).toHaveBeenCalledWith(807, ["ready-for-agent"], ["running"]);
  });

  it("is a no-op for a pre-claim death (null issue) — no gh calls", async () => {
    const { deps, io } = makeDeps();
    const issue = await reconcileDeadWorkerClaim(crashInfo({ issue: null }), deps);
    expect(issue).toBeNull();
    expect(io.crashedClaimState).not.toHaveBeenCalled();
    expect(io.comment).not.toHaveBeenCalled();
    expect(io.editLabels).not.toHaveBeenCalled();
  });

  it("leaves the issue untouched when it is no longer running", async () => {
    const { deps, io } = makeDeps({
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: false, envelopePosted: false })),
    });
    const issue = await reconcileDeadWorkerClaim(crashInfo(), deps);
    expect(issue).toBeNull();
    expect(io.comment).not.toHaveBeenCalled();
    expect(io.editLabels).not.toHaveBeenCalled();
  });

  it("is a no-op when crashedClaimState is not wired (back-compat)", async () => {
    const { deps } = makeDeps();
    delete (deps.gh as { crashedClaimState?: unknown }).crashedClaimState;
    const issue = await reconcileDeadWorkerClaim(crashInfo(), deps);
    expect(issue).toBeNull();
  });
});

describe("superviseTick — crash reconcile on respawn (#815)", () => {
  it("re-queues a dead worker's stranded running issue and counts the death", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false), // the slot's worker is dead
      // A slow death → respawn (not park), so the reconcile path runs.
      spawnSlot: vi.fn(async () => ({ pid: 9001, spawnEpoch: NOW })),
      resolveIterDir: vi.fn((): IterDirInfo | null => crashInfo()),
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: true, envelopePosted: false })),
      readyQueueDepth: vi.fn(async () => 3), // queue has work → respawn, not idle-park
    });
    deps.recoveryEnv = { RED_AFK_RETRY_CRASH: "2" };
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 1000; // long-lived → slow death → respawn

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.deaths).toEqual([0]); // the death is reported, not deaths=0
    expect(result.respawned).toContain(0);
    expect(result.crashReconciled).toEqual([807]);
    expect(io.editLabels).toHaveBeenCalledWith(807, ["ready-for-agent"], ["running"]);
  });

  it("does not reconcile when the slot circuit-trips and parks (sweep owns it)", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      now: vi.fn(() => NOW),
      resolveIterDir: vi.fn((): IterDirInfo | null => crashInfo()),
      crashedClaimState: vi.fn(async () => ({ ghOk: true, stillRunning: true, envelopePosted: false })),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 5000;
    slot.spawnEpoch = NOW; // zero-lifetime fast death
    // Prime the fast-death ring so this death trips the breaker → park + sweep.
    slot.deaths = Array.from({ length: 4 }, (_, k) => NOW - k);

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.parked).toEqual([0]);
    expect(result.crashReconciled).toEqual([]);
    expect(io.crashedClaimState).not.toHaveBeenCalled();
  });
});

describe("runSupervisor", () => {
  it("adopts live persisted slot pids and leaves dead ones for spawn", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => pid === 5000),
      spawnSlot: vi.fn(async (slot: number) => ({ pid: 9000 + slot, spawnEpoch: NOW })),
    });
    deps.proc.slotPid = vi.fn((slot: number) => (slot === 0 ? 5000 : slot === 1 ? 6000 : null));
    const state = initSupervisorState(2);

    const adoption = await adoptPersistedSlotPids(state, deps);

    expect(adoption.adopted).toEqual([{ slot: 0, pid: 5000 }]);
    expect(adoption.dead).toEqual([{ slot: 1, pid: 6000 }]);
    expect(state.slots[0]!.pid).toBe(5000);
    expect(state.slots[1]!.pid).toBeNull();

    await runSupervisor(state, deps, config({ target: 2 }), () => true);

    expect(io.spawnSlot).toHaveBeenCalledTimes(1);
    expect(io.spawnSlot).toHaveBeenCalledWith(1);
  });

  it("emits structured supervisor lane records for boot, tick, reconcile, wake, and scale", async () => {
    let clock = NOW;
    let probes = 0;
    const stop = () => {
      probes += 1;
      if (probes >= 2) clock = NOW + 15;
      return probes >= 2;
    };
    const { deps, io } = makeDeps({
      bootSweeps: vi.fn(async () => {}),
      now: vi.fn(() => clock),
      isAlive: vi.fn((pid: number) => pid !== 7000),
      resizeRequest: vi.fn()
        .mockResolvedValueOnce({ target: 2, shrinkMode: "drain-then-retire" })
        .mockResolvedValueOnce(null),
      spawnSlot: vi.fn(async (slot: number) => ({
        pid: slot === 0 ? 7000 : 8000 + slot,
        spawnEpoch: clock,
      })),
      readyQueueDepth: vi.fn(async () => 1),
    });
    const waitForEvent = vi.fn(async () => undefined);
    const state = initSupervisorState(1);

    await runSupervisor(
      state,
      { ...deps, wake: { waitForEvent } },
      config({ target: 1, pollIntervalS: 15, eventFallbackS: 60 }),
      stop,
    );

    const kinds = io.emitSupervisorEvent.mock.calls.map((call) => call[0].kind);
    expect(kinds).toContain("supervisor.boot-sweep");
    expect(kinds).toContain("supervisor.scale");
    expect(kinds).toContain("supervisor.dead-slot-reconcile");
    expect(kinds).toContain("supervisor.tick");
    expect(kinds).toContain("supervisor.wake");
    expect(io.emitSupervisorEvent.mock.calls.every((call) => call[0].kind.startsWith("supervisor."))).toBe(true);
    expect(io.emitSupervisorEvent.mock.calls.find((call) => call[0].kind === "supervisor.scale")?.[0]).toMatchObject({
      payload: { from: 1, to: 2, mode: "drain-then-retire" },
    });
    expect(io.emitSupervisorEvent.mock.calls.find((call) => call[0].kind === "supervisor.tick")?.[0]).toMatchObject({
      payload: expect.objectContaining({ ready_for_agent: 1, slots_busy: 1 }),
    });
  });

  it("spawns the initial fleet then exits on the stop-file", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(2);

    // Stop on the very first tick.
    await runSupervisor(state, deps, config({ target: 2 }), () => true);

    expect(io.spawnSlot).toHaveBeenCalledTimes(2);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
    expect(io.spawnSlot).toHaveBeenCalledWith(1);
    // Stop-file honoured → workers terminated.
    expect(io.killTree).toHaveBeenCalled();
    // Stopped on the first tick: guardedTick calls sleep(ceiling) once per tick,
    // but the inter-tick CADENCE sleep is never reached (the loop returns first).
    expect(io.sleep).toHaveBeenCalledTimes(1);
    expect(io.sleep).toHaveBeenCalledWith(120000);
  });

  it("sleeps the poll cadence between ticks before stopping on the 2nd", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(1);

    // Stop on the SECOND stop-file probe: tick 1 runs (no stop), the loop
    // sleeps the cadence, tick 2 sees the stop and returns.
    let probes = 0;
    const stop = () => {
      probes += 1;
      return probes >= 2;
    };

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    // Exactly one inter-tick CADENCE sleep at 15s (filtering out the per-tick
    // guardedTick ceiling sleeps, which use config.tickTimeoutS).
    expect(io.sleep).toHaveBeenCalledWith(15000);
    expect(io.sleep.mock.calls.filter((c) => c[0] === 15000)).toHaveLength(1);
  });

  it("honours a non-default poll cadence", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(1);
    let probes = 0;
    const stop = () => (++probes >= 2);

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 7 }), stop);

    expect(io.sleep).toHaveBeenCalledWith(7000);
    expect(io.sleep.mock.calls.filter((c) => c[0] === 7000)).toHaveLength(1);
  });

  it("wakes on a worker state-change event without waiting the timer, recording it (#934)", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    // A worker-state-change event that fires immediately each time the loop
    // begins its inter-tick wait — the event lane beats the (never-needed) timer.
    const waitForEvent = vi.fn(async () => undefined);
    const depsWithWake = { ...deps, wake: { waitForEvent } };
    const state = initSupervisorState(1);

    // tick 1 runs (no stop) → the loop waits and the event wakes it → tick 2 stops.
    let probes = 0;
    const stop = () => ++probes >= 2;

    await runSupervisor(
      state,
      depsWithWake,
      config({ target: 1, pollIntervalS: 15, eventFallbackS: 60 }),
      stop,
    );

    // The inter-tick wait woke on the EVENT lane, not the safety-net timer.
    expect(waitForEvent).toHaveBeenCalled();
    expect(state.wakeStats.event).toBe(1);
    expect(state.wakeStats.timer).toBe(0);
    // With an event lane wired the idle safety-net relaxes to eventFallbackS (60s);
    // the tight 15s poll cadence is never used → fewer idle wake-ups.
    expect(io.sleep.mock.calls.filter((c) => c[0] === 60000)).toHaveLength(1);
    expect(io.sleep.mock.calls.filter((c) => c[0] === 15000)).toHaveLength(0);
  });

  it("falls back to the timer cadence when no event lane is wired (no regression)", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(1);
    let probes = 0;
    const stop = () => ++probes >= 2;

    // No deps.wake → pure-timer loop at the unchanged 15s poll cadence.
    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    expect(state.wakeStats.timer).toBe(1);
    expect(state.wakeStats.event).toBe(0);
    expect(io.sleep.mock.calls.filter((c) => c[0] === 15000)).toHaveLength(1);
    expect(io.sleep.mock.calls.filter((c) => c[0] === 60000)).toHaveLength(0);
  });

  it("emits one structured fleet heartbeat per supervise tick with queue and slot counts", async () => {
    // readyQueueDepth is now called once per tick (in superviseTick, not in
    // emitFleetHeartbeat). The stop tick returns early and skips the fetch, so
    // only one call happens (tick 1). The second heartbeat uses queueDepth: 0
    // (the default for a stop tick).
    // A controllable clock instead of a fixed list of return values: the loop
    // calls now() a variable number of times per tick (superviseTick + the
    // lastProgressEpoch stamp + emitFleetHeartbeat), so a counted mock ran out and
    // fed `undefined` into isoFromEpoch ("Invalid time value"). The clock reads NOW
    // for tick 1 and flips to NOW+15 when the stop tick begins, so both heartbeats
    // get a valid, asserted ts regardless of how many now() calls each tick makes.
    let clock = NOW;
    let probes = 0;
    const stop = () => {
      probes += 1;
      if (probes >= 2) clock = NOW + 15;
      return probes >= 2;
    };
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => pid !== 1001),
      readyQueueDepth: vi.fn().mockResolvedValueOnce(5),
      now: vi.fn(() => clock),
    });
    const state = initSupervisorState(1);

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    expect(io.emitFleetHeartbeat).toHaveBeenCalledTimes(2);
    expect(io.emitFleetHeartbeat.mock.calls[0]![0]).toMatchObject({
      ts: new Date(NOW * 1000).toISOString(),
      target: 1,
      runner: "claude",
      shrinkMode: "drain-then-retire",
      readyForAgent: 5,
      slotsBusy: 1,
      slotsFree: 0,
      spawnsThisTick: 1,
    });
    expect(io.emitFleetHeartbeat.mock.calls[1]![0]).toMatchObject({
      ts: new Date((NOW + 15) * 1000).toISOString(),
      // Stop tick returns early before the queue-depth fetch; readyForAgent: 0.
      readyForAgent: 0,
      spawnsThisTick: 0,
    });
  });

  it("repairs a stale state heartbeat writer from the current tick snapshot", async () => {
    let clock = NOW;
    let probes = 0;
    const stop = () => {
      probes += 1;
      clock = NOW + probes * 15;
      return probes >= 3;
    };
    const { deps, io } = makeDeps({
      now: vi.fn(() => clock),
      emitFleetHeartbeat: vi.fn(async () => ({
        stateWritten: false,
        firehoseWritten: true,
        stateError: "simulated state write failure",
      })),
      repairFleetHeartbeat: vi.fn(async () => ({ stateWritten: true })),
    });
    const state = initSupervisorState(1);

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    expect(io.repairFleetHeartbeat).toHaveBeenCalledTimes(1);
    expect(io.repairFleetHeartbeat.mock.calls[0]![0]).toMatchObject({
      epoch: NOW + 30,
      readyForAgent: 0,
      slotsBusy: 1,
    });
    expect(io.logLines.some((line) => line.includes("heartbeat state writer stale"))).toBe(true);
  });

  it("does not report a cleanly exited worker pid as busy in the heartbeat", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      readyQueueDepth: vi.fn(async () => 0),
      lastExitCode: vi.fn(() => 0),
    });
    const state = initSupervisorState(1);
    let probes = 0;
    const stop = () => ++probes >= 2;

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    expect(io.spawnSlot).toHaveBeenCalledTimes(1);
    expect(io.killTree).not.toHaveBeenCalled();
    expect(io.logLines.some((line) => line.includes("dead slot reconciled: slot 0"))).toBe(true);
    expect(io.emitFleetHeartbeat.mock.calls[0]![0]).toMatchObject({
      slotsBusy: 0,
      slotsFree: 0,
      slotsParked: 1,
      spawnsThisTick: 0,
    });
    expect(state.slots[0]!.pid).toBeNull();
    expect(state.slots[0]!.idleParked).toBe(true);
  });
});

describe("envelope builders", () => {
  it("buildDiscardEnvelope mirrors the discard schema", () => {
    const body = buildDiscardEnvelope("claude", 0, "wAAAA,wBBBB", 5, ".red/tmp/afk-supervisor.log");
    expect(body).toContain('<details data-attempt-status="discarded">');
    expect(body).toContain("worker `claude`");
    expect(body).toContain("status: discarded");
    expect(body).toContain("slot parked after 5 fast deaths");
    expect(body).toContain('data-section="summary"');
    expect(body).toContain("worker IDs: wAAAA,wBBBB");
    expect(body).toContain("fast deaths: 5");
    expect(body).toContain("supervisor log: .red/tmp/afk-supervisor.log");
  });

  it("buildReaperEnvelope carries no-sentinel status + notes + log", () => {
    const body = buildReaperEnvelope({
      path: "/w/wTEST/190-a1",
      issue: 190,
      workerId: "wTEST",
      logTail: "stalled tool call",
      notes: "progress note",
      durationS: 200,
      attempt: 2,
    });
    expect(body).toContain('data-attempt-status="no-sentinel"');
    expect(body).toContain("worker `wTEST`");
    expect(body).toContain('data-section="notes"');
    expect(body).toContain('data-section="log"');
    expect(body).toContain("```toon");
    expect(body).toContain("stalled tool call");
  });
});
