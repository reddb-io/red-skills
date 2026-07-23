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

describe("superviseTick — continuous trunk freshness (#2074)", () => {
  it("refreshes the fleet trunk mirror on the first eligible tick", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      refreshTrunkMirror: vi.fn(async () => ({
        status: "refreshed",
        remoteRef: "origin/main",
        mirrorRef: "red-trunk",
        sha: "abc123",
      })),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;

    const result = await superviseTick(state, deps, config({ trunkFreshnessIntervalS: 60 }), () => false);

    expect(io.refreshTrunkMirror).toHaveBeenCalledOnce();
    expect(state.lastTrunkFreshnessEpoch).toBe(NOW);
    expect(result.trunkFreshness).toEqual({
      status: "refreshed",
      remoteRef: "origin/main",
      mirrorRef: "red-trunk",
      sha: "abc123",
      refreshedAtEpoch: NOW,
      intervalS: 60,
    });
  });

  it("throttles mirror refreshes inside the configured interval", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      now: vi.fn(() => NOW),
      refreshTrunkMirror: vi.fn(async () => ({
        status: "refreshed",
        remoteRef: "origin/main",
        mirrorRef: "red-trunk",
        sha: "abc123",
      })),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;
    state.lastTrunkFreshnessEpoch = NOW - 30;

    const result = await superviseTick(state, deps, config({ trunkFreshnessIntervalS: 60 }), () => false);

    expect(io.refreshTrunkMirror).not.toHaveBeenCalled();
    expect(state.lastTrunkFreshnessEpoch).toBe(NOW - 30);
    expect(result.trunkFreshness).toEqual({
      status: "throttled",
      refreshedAtEpoch: NOW - 30,
      nextDueEpoch: NOW + 30,
      intervalS: 60,
    });
  });

  it("records failed mirror refreshes and still throttles the next attempt", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      refreshTrunkMirror: vi.fn(async () => ({
        status: "failed",
        remoteRef: "origin/main",
        mirrorRef: "red-trunk",
        message: "fetch failed",
      })),
    });
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 9001;

    const result = await superviseTick(state, deps, config({ trunkFreshnessIntervalS: 60 }), () => false);

    expect(io.refreshTrunkMirror).toHaveBeenCalledOnce();
    expect(state.lastTrunkFreshnessEpoch).toBe(NOW);
    expect(result.trunkFreshness).toEqual({
      status: "failed",
      remoteRef: "origin/main",
      mirrorRef: "red-trunk",
      message: "fetch failed",
      refreshedAtEpoch: NOW,
      intervalS: 60,
    });
    expect(io.logLines).toContain("trunk mirror refresh failed: fetch failed");
  });

  it("surfaces the latest freshness outcome in heartbeat and structured tick events", async () => {
    let probes = 0;
    const stop = () => {
      probes += 1;
      return probes >= 2;
    };
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      refreshTrunkMirror: vi.fn(async () => ({
        status: "refreshed",
        remoteRef: "origin/main",
        mirrorRef: "red-trunk",
        sha: "abc123",
      })),
    });
    const state = initSupervisorState(1);

    await runSupervisor(state, deps, config({ target: 1, trunkFreshnessIntervalS: 60 }), stop);

    expect(io.emitFleetHeartbeat.mock.calls[0]?.[0]).toMatchObject({
      trunkFreshness: {
        status: "refreshed",
        remoteRef: "origin/main",
        mirrorRef: "red-trunk",
        sha: "abc123",
      },
    });
    expect(io.emitSupervisorEvent.mock.calls.find((call) => call[0].kind === "supervisor.tick")?.[0]).toMatchObject({
      payload: expect.objectContaining({
        trunk_freshness_status: "refreshed",
        trunk_freshness_remote_ref: "origin/main",
        trunk_freshness_mirror_ref: "red-trunk",
        trunk_freshness_sha: "abc123",
      }),
    });
  });
});

describe("superviseTick — drain USD budget ladder (#1188)", () => {
  it("keeps unchanged spawn behavior with no configured budget", async () => {
    const state = initSupervisorState(1);
    state.slots[0]!.pid = 123;
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      readyQueueDepth: vi.fn(async () => 1),
      fleetCostUsd: vi.fn(() => 999),
    });

    const result = await superviseTick(state, deps, config(), () => false);

    expect(result.respawned).toEqual([0]);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
    expect(io.fleetCostUsd).not.toHaveBeenCalled();
  });

  it("marks CRITICAL and downgrades only newly spawned workers", async () => {
    const state = initSupervisorState(2);
    state.slots[0]!.pid = 111;
    state.slots[1]!.pid = 222;
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => pid === 222),
      readyQueueDepth: vi.fn(async () => 2),
      fleetCostUsd: vi.fn(() => 9),
    });

    const result = await superviseTick(state, deps, config({ target: 2, drainBudgetUsd: 10 }), () => false);

    expect(result.drainBudget?.tier).toBe("CRITICAL");
    expect(result.respawned).toEqual([0]);
    expect(io.spawnSlot).toHaveBeenCalledOnce();
    expect(io.spawnSlot).toHaveBeenCalledWith(0, { taskTierDowngrade: true });
    expect(state.slots[1]!.pid).toBe(222);
  });

  it("HARD_STOP records queue state, stops new spawns, and lets in-flight workers finish", async () => {
    const logs: string[] = [];
    const state = initSupervisorState(2);
    state.slots[0]!.pid = 111;
    state.slots[1]!.pid = 222;
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => pid === 222),
      readyQueueDepth: vi.fn(async () => 3),
      fleetCostUsd: vi.fn(() => 10),
    });
    deps.log = (line) => logs.push(line);

    const result = await superviseTick(state, deps, config({ target: 2, drainBudgetUsd: 10 }), () => false);

    expect(result.drainBudget?.tier).toBe("HARD_STOP");
    expect(result.respawned).toEqual([]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(io.killTree).not.toHaveBeenCalled();
    expect(state.slots[0]!.pid).toBeNull();
    expect(state.slots[1]!.pid).toBe(222);
    expect(logs.join("\n")).toContain("schema_version: red.afk.drain_budget.v1");
    expect(logs.join("\n")).toContain("tier: HARD_STOP");
    expect(logs.join("\n")).toContain("ready_for_agent: 3");
  });
});

describe("half-open circuit breaker: cooldown schedule and probe scheduling", () => {
  it("a tripped slot does NOT spawn a probe before the base cooldown expires", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    // Advance clock by only 59s — one second short of the 60s base cooldown.
    io.now.mockReturnValue(NOW + 59);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.tripEpoch = NOW; // tripped at NOW, clock is NOW+59
    slot.backoffStep = 0;
    slot.pid = null;

    const result = await superviseTick(state, deps, config({ halfOpenBaseS: 60, halfOpenCapS: 3600 }), () => false);

    expect(result.halfOpened).toEqual([]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(slot.halfOpen).toBe(false);
  });

  it("a tripped slot spawns a probe exactly at the base cooldown", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => true),
      spawnSlot: vi.fn(async () => ({ pid: 7001, spawnEpoch: NOW + 60 })),
    });
    io.now.mockReturnValue(NOW + 60);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.tripEpoch = NOW;
    slot.backoffStep = 0;
    slot.pid = null;

    const result = await superviseTick(state, deps, config({ halfOpenBaseS: 60, halfOpenCapS: 3600 }), () => false);

    expect(result.halfOpened).toEqual([0]);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
    expect(slot.halfOpen).toBe(true);
    expect(slot.parked).toBe(true); // still parked — probe is running
    expect(slot.pid).toBe(7001);
  });

  it("a slot in half-open (probe running, alive) is not re-processed in the dead-slot loop", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.halfOpen = true; // probe already running
    slot.pid = 8888;
    slot.spawnEpoch = NOW - 5;
    slot.tripEpoch = NOW - 60;
    slot.backoffStep = 0;

    await superviseTick(state, deps, config(), () => false);

    // Probe is alive — no death handling, no new spawn.
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(slot.halfOpen).toBe(true);
    expect(slot.parked).toBe(true);
  });
});

describe("half-open circuit breaker: probe outcome — close-on-success", () => {
  it("a probe that survives past fastDeathThresholdS closes the circuit", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false), // probe is dead
      spawnSlot: vi.fn(async () => ({ pid: 9001, spawnEpoch: NOW })),
    });
    const logs: string[] = [];
    (deps as SupervisorDeps & { log: (l: string) => void }).log = (l: string) => logs.push(l);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.halfOpen = true;
    slot.pid = 5000;
    slot.spawnEpoch = NOW - 60; // alive for 60s — not a fast death (threshold 30s)
    slot.tripEpoch = NOW - 120;
    slot.backoffStep = 2;
    slot.deaths = [NOW - 80, NOW - 60, NOW - 50, NOW - 40, NOW - 30]; // old ring

    const result = await superviseTick(state, deps, config({ fastDeathThresholdS: 30 }), () => false);

    // Circuit closed: parked and halfOpen cleared, backoffStep reset, deaths ring reset.
    expect(slot.parked).toBe(false);
    expect(slot.halfOpen).toBe(false);
    expect(slot.backoffStep).toBe(0);
    expect(slot.tripEpoch).toBe(0);
    expect(slot.deaths).toEqual([]);
    expect(slot.swept).toBe(false); // reset so a future trip can sweep again

    // Slot respawned immediately after closing.
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
    expect(result.respawned).toContain(0);

    // Log mentions "circuit closed".
    expect(logs.some((l) => l.includes("circuit closed"))).toBe(true);
  });

  it("probe success with slow death (non-zero exit) still closes the circuit — exit code irrelevant", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
      lastExitCode: vi.fn(() => 1), // non-zero exit, but slow → not a fast death
      spawnSlot: vi.fn(async () => ({ pid: 9002, spawnEpoch: NOW })),
    });

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.halfOpen = true;
    slot.pid = 5001;
    slot.spawnEpoch = NOW - 120; // 120s — well past the fast-death threshold
    slot.tripEpoch = NOW - 200;
    slot.backoffStep = 1;

    await superviseTick(state, deps, config({ fastDeathThresholdS: 30 }), () => false);

    expect(slot.parked).toBe(false);
    expect(slot.halfOpen).toBe(false);
    expect(slot.backoffStep).toBe(0);
    expect(io.spawnSlot).toHaveBeenCalledWith(0);
  });
});

describe("half-open circuit breaker: probe outcome — re-park on failure", () => {
  it("a probe that fast-dies re-parks the slot with backoffStep incremented", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false), // probe dead
    });
    const logs: string[] = [];
    (deps as SupervisorDeps & { log: (l: string) => void }).log = (l: string) => logs.push(l);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.halfOpen = true;
    slot.pid = 6000;
    slot.spawnEpoch = NOW - 5; // fast death: only 5s (threshold 30s)
    slot.tripEpoch = NOW - 60;
    slot.backoffStep = 0; // was step 0 → should become step 1

    await superviseTick(state, deps, config({ fastDeathThresholdS: 30 }), () => false);

    // Re-parked: parked stays true, halfOpen cleared, step incremented.
    expect(slot.parked).toBe(true);
    expect(slot.halfOpen).toBe(false);
    expect(slot.backoffStep).toBe(1);
    // tripEpoch refreshed to the time of the probe failure.
    expect(slot.tripEpoch).toBe(NOW);
    expect(slot.pid).toBeNull();

    // No new spawn.
    expect(io.spawnSlot).not.toHaveBeenCalled();

    // Log mentions "circuit re-parked".
    expect(logs.some((l) => l.includes("circuit re-parked"))).toBe(true);
  });

  it("each successive probe fast-death increments backoffStep (backoff cap)", async () => {
    // Drive probe failures directly via handleDeadSlot to verify backoffStep grows
    // and the exponential cap. Each call sets up a half-open probe that fast-dies.
    const BASE = 1;
    const CAP = 8;
    const cfg = config({ fastDeathThresholdS: 30, halfOpenBaseS: BASE, halfOpenCapS: CAP });
    const { deps, io } = makeDeps();
    const logs: string[] = [];
    (deps as SupervisorDeps & { log: (l: string) => void }).log = (l: string) => logs.push(l);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.parked = true;
    slot.tripEpoch = NOW;

    // Drive 6 fast-death probes: backoffStep goes 0→1→2→3→4→5→6.
    for (let step = 0; step < 6; step++) {
      slot.halfOpen = true;
      slot.pid = 9000 + step;
      slot.spawnEpoch = NOW - 5; // 5s lifetime < 30s → fast-death

      const { parked } = await handleDeadSlot(0, slot, deps, cfg);
      expect(parked).toBe(true);
      expect(slot.halfOpen).toBe(false);
      expect(slot.backoffStep).toBe(step + 1);
      expect(slot.tripEpoch).toBe(NOW);
    }

    // backoffStep is now 6: computed backoff = min(1×2^6, 8) = min(64, 8) = 8 (capped).
    const { computeHalfOpenBackoff: backoff } = await import("../src/core/slot-circuit.js");
    expect(backoff(slot.backoffStep, { halfOpenBaseS: BASE, halfOpenCapS: CAP })).toBe(CAP);
    // Another failure at step 7 also returns cap.
    expect(backoff(slot.backoffStep + 1, { halfOpenBaseS: BASE, halfOpenCapS: CAP })).toBe(CAP);

    // Verify isHalfOpenDue respects the cap at step 6.
    const { isHalfOpenDue: due } = await import("../src/core/slot-circuit.js");
    expect(due(slot.tripEpoch, slot.backoffStep, NOW + 7, { halfOpenBaseS: BASE, halfOpenCapS: CAP })).toBe(false);
    expect(due(slot.tripEpoch, slot.backoffStep, NOW + 8, { halfOpenBaseS: BASE, halfOpenCapS: CAP })).toBe(true);

    // Logs include at least one "circuit re-parked" entry.
    expect(logs.filter((l) => l.includes("circuit re-parked")).length).toBeGreaterThan(0);
    expect(io.spawnSlot).not.toHaveBeenCalled(); // no new spawns on probe fast-deaths
  });

  it("existing circuit-trip sweep runs on trip and is NOT re-run on probe fast-death", async () => {
    const { deps, io } = makeDeps({
      isAlive: vi.fn(() => false),
    });
    io.parkedSlotWork.mockReturnValue({
      workers: [{ workerId: "wXXXX", pairs: [{ dir: "/tmp/iter", issue: 100 }] }],
      supervisorLogPath: ".red/tmp/afk-supervisor.log",
    });

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;

    // Simulate a fresh trip (sweep not yet run).
    slot.pid = 7777;
    slot.spawnEpoch = NOW - 5; // fast death
    slot.deaths = [NOW - 80, NOW - 70, NOW - 60, NOW - 50]; // 4 deaths already

    // One more death → trips (K=5).
    await handleDeadSlot(0, slot, deps, config({ circuitK: 5, halfOpenBaseS: 60, halfOpenCapS: 3600 }));
    expect(slot.parked).toBe(true);
    expect(slot.swept).toBe(true);
    expect(io.comment).toHaveBeenCalledTimes(1); // discard envelope posted

    // Now simulate a probe fast-death: swept should block re-sweep.
    io.comment.mockClear();
    slot.halfOpen = true;
    slot.pid = 8888;
    slot.spawnEpoch = NOW - 5;

    await handleDeadSlot(0, slot, deps, config({ fastDeathThresholdS: 30, halfOpenBaseS: 60, halfOpenCapS: 3600 }));
    expect(slot.parked).toBe(true);
    expect(slot.halfOpen).toBe(false);
    // No new sweep / envelope on probe fast-death.
    expect(io.comment).not.toHaveBeenCalled();
  });
});

describe("half-open circuit breaker: slot recovers without supervisor restart", () => {
  it("a parked slot recovers end-to-end when the probe succeeds", async () => {
    // Drives open → half-open → closed using three ticks.
    // isAlive tracks spawned pids so the probe is alive during the spawning tick.
    let clock = NOW;
    const spawnedPids = new Set<number>();
    let nextSpawnPid = 1000;
    const { deps, io } = makeDeps({
      // Probe is alive while in spawnedPids; dead once we clear the set.
      isAlive: vi.fn((pid: number) => spawnedPids.has(pid)),
      spawnSlot: vi.fn(async () => {
        const pid = nextSpawnPid++;
        spawnedPids.add(pid);
        return { pid, spawnEpoch: clock };
      }),
    });
    io.now.mockImplementation(() => clock);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;

    // Pre-condition: slot already tripped (parked=true), sweep done.
    slot.parked = true;
    slot.swept = true;
    slot.tripEpoch = NOW;
    slot.backoffStep = 0;
    slot.pid = null;

    const cfg = config({ fastDeathThresholdS: 30, halfOpenBaseS: 60, halfOpenCapS: 3600 });

    // Tick 1 (clock=NOW+30): before cooldown — no probe.
    clock = NOW + 30;
    let result = await superviseTick(state, deps, cfg, () => false);
    expect(result.halfOpened).toEqual([]);
    expect(slot.halfOpen).toBe(false);

    // Tick 2 (clock=NOW+60): cooldown expires — probe spawned and alive.
    // Do NOT override isAlive here; the spawned-pid tracker makes the probe alive.
    clock = NOW + 60;
    result = await superviseTick(state, deps, cfg, () => false);
    expect(result.halfOpened).toEqual([0]);
    expect(slot.halfOpen).toBe(true);
    expect(slot.parked).toBe(true);
    const probePid = slot.pid!;
    expect(probePid).toBeGreaterThan(0);
    const probeSpawnEpoch = slot.spawnEpoch;

    // Tick 3 (probe ran 60s > fastDeathThresholdS=30s): probe dies → circuit closes.
    // Remove the probe from spawnedPids so isAlive returns false for it.
    clock = probeSpawnEpoch + 60;
    spawnedPids.delete(probePid);
    result = await superviseTick(state, deps, cfg, () => false);

    // Circuit closed: slot back to normal, respawned immediately.
    expect(slot.parked).toBe(false);
    expect(slot.halfOpen).toBe(false);
    expect(slot.backoffStep).toBe(0);
    expect(slot.deaths).toEqual([]);
    expect(result.respawned).toContain(0);
  });
});

describe("resolveSupervisorConfig — half-open knobs (#628)", () => {
  it("defaults halfOpenBaseS and halfOpenCapS", () => {
    expect(resolveSupervisorConfig({}).halfOpenBaseS).toBe(60);
    expect(resolveSupervisorConfig({}).halfOpenCapS).toBe(3600);
  });

  it("reads RED_AFK_HALF_OPEN_BASE_S", () => {
    expect(resolveSupervisorConfig({ RED_AFK_HALF_OPEN_BASE_S: "120" }).halfOpenBaseS).toBe(120);
    expect(resolveSupervisorConfig({ RED_AFK_HALF_OPEN_BASE_S: "abc" }).halfOpenBaseS).toBe(60);
  });

  it("reads RED_AFK_HALF_OPEN_CAP_S", () => {
    expect(resolveSupervisorConfig({ RED_AFK_HALF_OPEN_CAP_S: "7200" }).halfOpenCapS).toBe(7200);
    expect(resolveSupervisorConfig({ RED_AFK_HALF_OPEN_CAP_S: "not-a-number" }).halfOpenCapS).toBe(3600);
  });
});
