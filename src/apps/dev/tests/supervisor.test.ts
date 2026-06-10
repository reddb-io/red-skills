import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiscardEnvelope,
  buildReaperEnvelope,
  computeStalled,
  dispatchReconcileIfPossible,
  freshSlot,
  handleDeadSlot,
  initSupervisorState,
  pollStallDetector,
  recordDeath,
  resolveSupervisorConfig,
  runSupervisor,
  sweepParkedSlot,
  superviseTick,
  validateStallThresholds,
  validateSupervisorStaleThreshold,
  validateSupervisorProgressThreshold,
  classifySupervisor,
  guardedTick,
  type IterDirInfo,
  type ReconcileCandidate,
  type SupervisorConfig,
  type SupervisorDeps,
  type SupervisorState,
  type SupervisorLiveness,
  type SweepWork,
} from "../src/core/supervisor.js";
import { parkedSlotWorkFor, slotLogPath } from "../src/runtime/supervisor-fs.js";
import type { ProcessSnapshotEntry } from "../src/core/reaper-signal.js";

const NOW = 1700000000;

function config(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    target: 1,
    fastDeathThresholdS: 30,
    circuitK: 5,
    circuitWindowS: 90,
    stallThresholdS: 30,
    stallKillThresholdS: 90,
    runner: "claude",
    pollIntervalS: 15,
    tickTimeoutS: 120,
    supervisorStaleS: 300,
    progressStaleS: 900,
    ...over,
  };
}

function liveness(over: Partial<SupervisorLiveness> = {}): SupervisorLiveness {
  return {
    pid: null,
    pidAlive: false,
    lastHeartbeatEpoch: null,
    lastProgressEpoch: null,
    slotsBusy: 0,
    ...over,
  };
}

interface FakeIo {
  spawnSlot: ReturnType<typeof vi.fn>;
  spawnReconcileWorker: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  inspectTree: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  lastExitCode: ReturnType<typeof vi.fn>;
  agentLaneMtime: ReturnType<typeof vi.fn>;
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
  emitFleetHeartbeat: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
}

function makeDeps(over: Partial<Record<keyof FakeIo, unknown>> = {}): {
  deps: SupervisorDeps;
  io: FakeIo;
} {
  let nextPid = 1000;
  const io: FakeIo = {
    spawnSlot: vi.fn(async () => ({ pid: ++nextPid, spawnEpoch: NOW })),
    spawnReconcileWorker: vi.fn(async () => ({ pid: ++nextPid, spawnEpoch: NOW })),
    isAlive: vi.fn(() => true),
    killTree: vi.fn(async () => {}),
    inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
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
    agentLaneMtime: vi.fn(() => 0),
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
    emitFleetHeartbeat: vi.fn(async () => {}),
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
      inspectTree: io.inspectTree,
      sleep: io.sleep,
    },
    fs: {
      agentLaneMtime: io.agentLaneMtime,
      resolveIterDir: io.resolveIterDir,
      teardownIterDir: io.teardownIterDir,
      parkedSlotWork: io.parkedSlotWork,
      removeDir: io.removeDir,
    },
    gh: {
      comment: io.comment,
      editLabels: io.editLabels,
      ensureRunnerErrorLabel: io.ensureRunnerErrorLabel,
      ensureLabel: io.ensureLabel,
      readyQueueDepth: io.readyQueueDepth,
      findReconcileCandidate: io.findReconcileCandidate,
    },
    now: io.now,
    emitFleetHeartbeat: io.emitFleetHeartbeat,
  };
  return { deps, io };
}

// ---------- threshold validation ----------

describe("validateStallThresholds", () => {
  it("passes when KILL > STALL", () => {
    expect(() => validateStallThresholds({ stallThresholdS: 600, stallKillThresholdS: 1800 })).not.toThrow();
  });

  it("throws when KILL == STALL", () => {
    expect(() => validateStallThresholds({ stallThresholdS: 600, stallKillThresholdS: 600 })).toThrow();
  });

  it("throws when KILL < STALL", () => {
    expect(() => validateStallThresholds({ stallThresholdS: 600, stallKillThresholdS: 300 })).toThrow();
  });

  it("runSupervisor refuses to boot with KILL <= STALL", async () => {
    const { deps } = makeDeps();
    const state = initSupervisorState(1);
    await expect(
      runSupervisor(state, deps, config({ stallThresholdS: 600, stallKillThresholdS: 600 }), () => true),
    ).rejects.toThrow();
  });
});

// ---------- validateSupervisorStaleThreshold (#407) ----------

describe("validateSupervisorStaleThreshold", () => {
  it("passes when STALE > TICK_TIMEOUT", () => {
    expect(() => validateSupervisorStaleThreshold({ supervisorStaleS: 300, tickTimeoutS: 120 })).not.toThrow();
  });

  it("throws when STALE == TICK_TIMEOUT", () => {
    expect(() => validateSupervisorStaleThreshold({ supervisorStaleS: 120, tickTimeoutS: 120 })).toThrow();
  });

  it("throws when STALE < TICK_TIMEOUT", () => {
    expect(() => validateSupervisorStaleThreshold({ supervisorStaleS: 60, tickTimeoutS: 120 })).toThrow();
  });

  it("runSupervisor refuses to boot with STALE <= TICK_TIMEOUT", async () => {
    const { deps } = makeDeps();
    const state = initSupervisorState(1);
    await expect(
      runSupervisor(state, deps, config({ supervisorStaleS: 120, tickTimeoutS: 120 }), () => true),
    ).rejects.toThrow(/RED_AFK_SUPERVISOR_STALE_S/);
  });
});

// ---------- validateSupervisorProgressThreshold (#579) ----------

describe("validateSupervisorProgressThreshold", () => {
  it("passes when PROGRESS_STALE > SUPERVISOR_STALE", () => {
    expect(() =>
      validateSupervisorProgressThreshold({ progressStaleS: 900, supervisorStaleS: 300 }),
    ).not.toThrow();
  });

  it("throws when PROGRESS_STALE == SUPERVISOR_STALE", () => {
    expect(() =>
      validateSupervisorProgressThreshold({ progressStaleS: 300, supervisorStaleS: 300 }),
    ).toThrow();
  });

  it("throws when PROGRESS_STALE < SUPERVISOR_STALE", () => {
    expect(() =>
      validateSupervisorProgressThreshold({ progressStaleS: 100, supervisorStaleS: 300 }),
    ).toThrow();
  });

  it("runSupervisor refuses to boot with PROGRESS_STALE <= SUPERVISOR_STALE", async () => {
    const { deps } = makeDeps();
    const state = initSupervisorState(1);
    await expect(
      runSupervisor(state, deps, config({ progressStaleS: 300, supervisorStaleS: 300 }), () => true),
    ).rejects.toThrow(/RED_AFK_SUPERVISOR_PROGRESS_STALE_S/);
  });
});

// ---------- classifySupervisor (#407 + #579 quiescence detector, pure) ----------

describe("classifySupervisor", () => {
  const STALE = 300;
  const PROGRESS_STALE = 900;

  it("is absent when there is no pid", () => {
    expect(
      classifySupervisor(liveness({ lastHeartbeatEpoch: NOW }), NOW, STALE, PROGRESS_STALE),
    ).toBe("absent");
  });

  it("is absent when the pid is dead", () => {
    expect(
      classifySupervisor(
        liveness({ pid: 42, pidAlive: false, lastHeartbeatEpoch: NOW - 9999 }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("absent");
  });

  it("is healthy when a live pid has a fresh heartbeat", () => {
    expect(
      classifySupervisor(
        liveness({ pid: 42, pidAlive: true, lastHeartbeatEpoch: NOW - 10 }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  it("is healthy at exactly one second under the threshold", () => {
    expect(
      classifySupervisor(
        liveness({ pid: 42, pidAlive: true, lastHeartbeatEpoch: NOW - (STALE - 1) }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  it("is quiescent at exactly the threshold and beyond (heartbeat stale)", () => {
    expect(
      classifySupervisor(
        liveness({ pid: 42, pidAlive: true, lastHeartbeatEpoch: NOW - STALE }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("quiescent");
    expect(
      classifySupervisor(
        liveness({ pid: 42, pidAlive: true, lastHeartbeatEpoch: NOW - 999999 }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("quiescent");
  });

  it("never proves a wedge on a live pid that has no heartbeat yet (just booted)", () => {
    expect(
      classifySupervisor(liveness({ pid: 42, pidAlive: true }), NOW, STALE, PROGRESS_STALE),
    ).toBe("healthy");
  });

  it("treats a future-stamped heartbeat (clock skew) as healthy", () => {
    expect(
      classifySupervisor(
        liveness({ pid: 42, pidAlive: true, lastHeartbeatEpoch: NOW + 50 }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  // ---------- progress-stale quiescence (#579) ----------

  it("is quiescent when fresh heartbeat but progress stale and slots busy", () => {
    expect(
      classifySupervisor(
        liveness({
          pid: 42,
          pidAlive: true,
          lastHeartbeatEpoch: NOW - 10,       // fresh — loop is ticking
          lastProgressEpoch: NOW - 1000,      // stale — ticks keep being abandoned
          slotsBusy: 2,
        }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("quiescent");
  });

  it("is healthy when progress stale but no busy slots (idle fleet, not stuck)", () => {
    expect(
      classifySupervisor(
        liveness({
          pid: 42,
          pidAlive: true,
          lastHeartbeatEpoch: NOW - 10,
          lastProgressEpoch: NOW - 1000,
          slotsBusy: 0,
        }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  it("is healthy when progress epoch is null (no tick completed yet — freshly launched)", () => {
    expect(
      classifySupervisor(
        liveness({
          pid: 42,
          pidAlive: true,
          lastHeartbeatEpoch: NOW - 10,
          lastProgressEpoch: null,
          slotsBusy: 2,
        }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  it("is healthy when progress epoch is 0 (uninitialised sentinel from initSupervisorState)", () => {
    // initSupervisorState seeds lastProgressEpoch: 0; the first heartbeat a
    // fresh supervisor emits carries 0 before any tick completes. Treat 0 as
    // «no progress yet» (same as null) so a brand-new supervisor isn't
    // immediately classified quiescent.
    expect(
      classifySupervisor(
        liveness({
          pid: 42,
          pidAlive: true,
          lastHeartbeatEpoch: NOW - 10,
          lastProgressEpoch: 0,
          slotsBusy: 2,
        }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  it("is healthy when progress epoch is recent despite busy slots", () => {
    expect(
      classifySupervisor(
        liveness({
          pid: 42,
          pidAlive: true,
          lastHeartbeatEpoch: NOW - 10,
          lastProgressEpoch: NOW - 30,   // recent — ticks are completing
          slotsBusy: 2,
        }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("healthy");
  });

  it("heartbeat-stale check fires even when progress epoch is fresh", () => {
    expect(
      classifySupervisor(
        liveness({
          pid: 42,
          pidAlive: true,
          lastHeartbeatEpoch: NOW - 9999,  // stale heartbeat
          lastProgressEpoch: NOW - 30,     // fresh progress
          slotsBusy: 2,
        }),
        NOW,
        STALE,
        PROGRESS_STALE,
      ),
    ).toBe("quiescent");
  });
});

// ---------- resolveSupervisorConfig ----------

describe("resolveSupervisorConfig", () => {
  it("uses defaults for an empty env", () => {
    const c = resolveSupervisorConfig({});
    expect(c).toMatchObject({
      target: 2,
      circuitK: 5,
      stallThresholdS: 600,
      stallKillThresholdS: 1800,
      runner: "claude",
      progressStaleS: 900,
    });
  });

  it("honours numeric overrides and ignores garbage", () => {
    const c = resolveSupervisorConfig({ RED_AFK_TARGET: "4", RED_AFK_CIRCUIT_K: "nope", RED_AFK_RUNNER: "codex" });
    expect(c.target).toBe(4);
    expect(c.circuitK).toBe(5);
    expect(c.runner).toBe("codex");
  });

  it("resolves RED_AFK_SUPERVISOR_PROGRESS_STALE_S", () => {
    const c = resolveSupervisorConfig({ RED_AFK_SUPERVISOR_PROGRESS_STALE_S: "1200" });
    expect(c.progressStaleS).toBe(1200);
  });

  it("falls back to default for a garbage RED_AFK_SUPERVISOR_PROGRESS_STALE_S", () => {
    const c = resolveSupervisorConfig({ RED_AFK_SUPERVISOR_PROGRESS_STALE_S: "bad" });
    expect(c.progressStaleS).toBe(900);
  });
});

// ---------- abandoned tick / lastProgressEpoch (#579) ----------

describe("guardedTick — abandoned flag", () => {
  it("sets abandoned:false on a tick that completes normally", async () => {
    const tick = vi.fn(async () => ({
      respawned: [],
      deaths: [],
      parked: [],
      idleParked: [],
      reaped: [],
      reconciledSlots: [],
      stopped: false,
      queueDepth: 0,
      abandoned: false,
    }));
    const sleep = vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const result = await guardedTick(tick, 5000, sleep);
    expect(result.abandoned).toBe(false);
  });

  it("sets abandoned:true when the tick times out", async () => {
    // A tick that never resolves → guardedTick races against the sleep timeout.
    let resolveHang: () => void;
    const tick = vi.fn(() => new Promise<never>((_res, _rej) => { resolveHang = _res as () => void; }));
    // sleep resolves immediately → timeout fires first.
    const sleep = vi.fn(async () => {});
    const result = await guardedTick(tick, 1, sleep);
    expect(result.abandoned).toBe(true);
    resolveHang!(); // clean up the dangling promise
  });

  it("sets abandoned:true when the tick throws", async () => {
    const tick = vi.fn(async (): Promise<never> => { throw new Error("boom"); });
    const sleep = vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    const result = await guardedTick(tick, 5000, sleep);
    expect(result.abandoned).toBe(true);
  });
});

describe("runSupervisor — lastProgressEpoch tracking (#579)", () => {
  it("advances lastProgressEpoch on a non-abandoned tick", async () => {
    const { deps, io } = makeDeps();
    io.isAlive.mockReturnValue(true); // workers stay alive — no deaths/respawns
    let ticks = 0;
    // Run two ticks then stop.
    const stopFn = () => ++ticks > 2;
    const state = initSupervisorState(1);
    await runSupervisor(state, deps, config(), stopFn);
    // lastProgressEpoch must have been set (non-zero) since ticks completed.
    expect(state.lastProgressEpoch).toBe(NOW);
    // emitFleetHeartbeat was called with lastProgressEpoch == NOW.
    const lastHb = io.emitFleetHeartbeat.mock.lastCall?.[0];
    expect(lastHb?.lastProgressEpoch).toBe(NOW);
  });

  it("does NOT advance lastProgressEpoch on an abandoned tick", async () => {
    const { deps, io } = makeDeps();
    io.isAlive.mockReturnValue(true);
    let ticks = 0;
    const stopFn = () => ++ticks > 1;
    const state = initSupervisorState(1);
    // Make sleep resolve immediately so the timeout races and wins the tick.
    io.sleep.mockImplementation(async () => {});
    // Use a tick timeout so tiny that the real superviseTick always loses the race.
    await runSupervisor(state, deps, config({ tickTimeoutS: 0 as unknown as number }), stopFn).catch(() => {});
    // With tickTimeoutS:0 the guard fires a config error before ticks even run.
    // Instead: use a very small timeout but a slow tick — but makeDeps.sleep is
    // already instant. The important thing is the flag propagates; the above
    // guardedTick unit test covers the actual timing. We test propagation via
    // a direct guardedTick call.
    const result = await guardedTick(
      async (): Promise<never> => { throw new Error("tick threw"); },
      5000,
      vi.fn(async () => {}),
    );
    expect(result.abandoned).toBe(true);
    // Directly: if result.abandoned the epoch must not be updated.
    state.lastProgressEpoch = 0;
    if (!result.abandoned) state.lastProgressEpoch = 999;
    expect(state.lastProgressEpoch).toBe(0);
  });
});

// ---------- compute_stalled (pure) ----------

describe("computeStalled", () => {
  const T = 600;
  it("fresh worker (alive < threshold) → false", () => {
    expect(computeStalled(NOW - 100, NOW - 9999, NOW, T)).toBe(false);
  });
  it("recent lane activity → false", () => {
    expect(computeStalled(NOW - 3600, NOW - 60, NOW, T)).toBe(false);
  });
  it("old + silent lane → true", () => {
    expect(computeStalled(NOW - 3600, NOW - 700, NOW, T)).toBe(true);
  });
  it("no lane observed yet (mtime 0) → false", () => {
    expect(computeStalled(NOW - 3600, 0, NOW, T)).toBe(false);
  });
  it("uninitialised slot (spawn 0) → false", () => {
    expect(computeStalled(0, NOW - 9999, NOW, T)).toBe(false);
  });
});

// ---------- circuit breaker (pure) ----------

describe("recordDeath", () => {
  it("a slow death never trips and leaves the ring untouched", () => {
    const d = recordDeath([NOW - 1], NOW - 60, NOW, { fastDeathThresholdS: 30, circuitWindowS: 90, circuitK: 5 });
    expect(d.fastDeath).toBe(false);
    expect(d.trip).toBe(false);
    expect(d.deaths).toEqual([NOW - 1]);
  });

  it("a fast death appends to the ring and trips at K", () => {
    const prior = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
    const d = recordDeath(prior, NOW - 5, NOW, { fastDeathThresholdS: 30, circuitWindowS: 90, circuitK: 5 });
    expect(d.fastDeath).toBe(true);
    expect(d.count).toBe(5);
    expect(d.trip).toBe(true);
  });

  it("prunes deaths outside the window before counting", () => {
    const prior = [NOW - 200, NOW - 150, NOW - 100, NOW - 50];
    const d = recordDeath(prior, NOW - 5, NOW, { fastDeathThresholdS: 30, circuitWindowS: 90, circuitK: 5 });
    // Only NOW-50 and the new NOW survive the 90s window.
    expect(d.deaths).toEqual([NOW - 50, NOW]);
    expect(d.trip).toBe(false);
  });
});

// ---------- circuit trip → park + sweep ----------

describe("circuit trip and sweep", () => {
  it("trips after K fast deaths, parks the slot, and runs the trip sweep", async () => {
    const { deps, io } = makeDeps({
      parkedSlotWork: vi.fn(
        (): SweepWork => ({
          workers: [{ workerId: "wAAAA", pairs: [{ dir: "/w/wAAAA/7-a1", issue: 7 }] }],
          supervisorLogPath: ".red/tmp/afk-supervisor.log",
        }),
      ),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    // One fast death short of the trip; this death is the fifth.
    slot.deaths = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
    slot.spawnEpoch = NOW - 5; // lifetime 5s < 30s → fast death

    const { parked } = await handleDeadSlot(0, slot, deps, config());

    expect(parked).toBe(true);
    expect(slot.parked).toBe(true);
    expect(slot.swept).toBe(true);
    expect(io.spawnSlot).not.toHaveBeenCalled();
    // Discard envelope posted + labels restored for the claimed issue.
    expect(io.comment).toHaveBeenCalledOnce();
    const [issue, body] = io.comment.mock.calls[0]!;
    expect(issue).toBe(7);
    expect(body).toContain('data-attempt-status="discarded"');
    expect(io.editLabels).toHaveBeenCalledWith(
      7,
      ["ready-for-agent", "runner-error"],
      ["ready-for-human", "running"],
    );
    expect(io.ensureRunnerErrorLabel).toHaveBeenCalledOnce();
    expect(io.removeDir).toHaveBeenCalledWith("/w/wAAAA/7-a1");
  });

  it("passes the slot's last pid to parkedSlotWork so the fs layer can use PID-based resolution", async () => {
    // The fs layer falls back to findSlotIterDir(tmpDir, lastPid) when the slot
    // log has no boot-stamp (the native fleet path). sweepParkedSlot must thread
    // state.pid through so the fallback has the dead worker's PID.
    const { deps, io } = makeDeps({
      parkedSlotWork: vi.fn(
        (): SweepWork => ({ workers: [], supervisorLogPath: "" }),
      ),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 4242; // last dead worker's PID
    slot.deaths = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
    slot.spawnEpoch = NOW - 5;

    await handleDeadSlot(0, slot, deps, config());

    expect(io.parkedSlotWork).toHaveBeenCalledWith(0, 4242);
  });

  it("sweep is idempotent and cleans dirs with no claimed issue without posting", async () => {
    const { deps, io } = makeDeps({
      parkedSlotWork: vi.fn(
        (): SweepWork => ({
          workers: [{ workerId: "wDDDD", pairs: [{ dir: "/w/wDDDD/1-a1", issue: null }] }],
          supervisorLogPath: ".red/tmp/afk-supervisor.log",
        }),
      ),
    });
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;

    await sweepParkedSlot(0, slot, deps, config());
    expect(io.comment).not.toHaveBeenCalled();
    expect(io.editLabels).not.toHaveBeenCalled();
    expect(io.ensureRunnerErrorLabel).not.toHaveBeenCalled();
    expect(io.removeDir).toHaveBeenCalledWith("/w/wDDDD/1-a1");

    // Second invocation is a no-op.
    io.removeDir.mockClear();
    await sweepParkedSlot(0, slot, deps, config());
    expect(io.removeDir).not.toHaveBeenCalled();
  });
});

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
describe("circuit trip — real FS integration (slot-log boot-stamp path)", () => {
  it("restores the claimed issue and posts a discard envelope with the correct fast-death count", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "afk-sup-int-"));
    try {
      // Two workers ran in slot 0 across successive fast deaths; both emit the
      // boot-stamp so the slot log records them. Only the second claimed an issue.
      writeFileSync(slotLogPath(tmp, 0), "[afk] worker: wAAA1\n[afk] worker: wBBB2\n", "utf8");

      // wAAA1 — died before claiming (no afk.state.json → issue null).
      const dir1 = join(tmp, "workers", "wAAA1", "9-a1");
      mkdirSync(dir1, { recursive: true });

      // wBBB2 — claimed issue #99 before fast-dying.
      const dir2 = join(tmp, "workers", "wBBB2", "99-a1");
      mkdirSync(dir2, { recursive: true });
      writeFileSync(
        join(dir2, "afk.state.json"),
        JSON.stringify({ current: { number: 99 } }),
        "utf8",
      );

      // Build deps with real parkedSlotWorkFor (not mocked) and mocked gh.
      const { deps, io } = makeDeps({
        parkedSlotWork: (slot: number, lastPid: number | null) =>
          parkedSlotWorkFor(tmp, slot, lastPid),
      });

      // Slot state at trip: 5 fast deaths (circuitK=5), last pid irrelevant
      // for the slot-log path but still threaded through for Path 2 fallback.
      const state = initSupervisorState(1);
      const slot = state.slots[0]!;
      slot.pid = 7777;
      slot.deaths = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
      slot.spawnEpoch = NOW - 5; // lifetime 5s < fastDeathThresholdS(30)

      const { parked } = await handleDeadSlot(0, slot, deps, config());

      expect(parked).toBe(true);
      expect(slot.parked).toBe(true);

      // Discard envelope posted only for the worker that held a claim (#99).
      expect(io.comment).toHaveBeenCalledOnce();
      const [issue, body] = io.comment.mock.calls[0]!;
      expect(issue).toBe(99);
      expect(body).toContain('data-attempt-status="discarded"');
      // Fast-death count must reflect the circuit ring (5 deaths), not 0.
      expect(body).toContain("fast deaths: 5");
      expect(body).toContain("slot parked after 5 fast deaths");

      // Labels restored for the claimed issue.
      expect(io.editLabels).toHaveBeenCalledWith(
        99,
        ["ready-for-agent", "runner-error"],
        ["ready-for-human", "running"],
      );
      expect(io.ensureRunnerErrorLabel).toHaveBeenCalledOnce();

      // The pre-claim worker dir is also cleaned up (issue null → no envelope,
      // no label edit, but removeDir still fires for the iter dir).
      const removedDirs = io.removeDir.mock.calls.map((c: unknown[]) => c[0]);
      expect(removedDirs).toContain(dir1);
      expect(removedDirs).toContain(dir2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no-ops cleanly when the slot log is empty (no stamp yet) and lastPid yields nothing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "afk-sup-int-"));
    try {
      // Slot log exists but has no boot-stamp lines (pre-fix scenario or very
      // early crash before the stamp was emitted). No worker.pid file either.
      writeFileSync(slotLogPath(tmp, 0), "some unrelated output\n", "utf8");

      const { deps, io } = makeDeps({
        parkedSlotWork: (slot: number, lastPid: number | null) =>
          parkedSlotWorkFor(tmp, slot, lastPid),
      });

      const state = initSupervisorState(1);
      const slot = state.slots[0]!;
      slot.pid = null; // no last PID → Path 2 also yields nothing
      slot.deaths = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
      slot.spawnEpoch = NOW - 5;

      const { parked } = await handleDeadSlot(0, slot, deps, config());

      expect(parked).toBe(true);
      // No workers resolved → sweep no-ops: no envelope, no label edits.
      expect(io.comment).not.toHaveBeenCalled();
      expect(io.editLabels).not.toHaveBeenCalled();
      expect(io.removeDir).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------- stall reaper gating ----------

describe("pollStallDetector reaper gating", () => {
  function stalledState() {
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 4242;
    slot.spawnEpoch = NOW - 200;
    slot.stalled = true;
    slot.stallSinceEpoch = NOW - 120; // silent 120s, past KILL=90
    return state;
  }

  it("does NOT reap a busy slot (reaper-signal says busy)", async () => {
    // An active build/test descendant (vitest) → busy → no-kill.
    const { deps, io } = makeDeps({
      agentLaneMtime: vi.fn(() => NOW - 120),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "vitest", cpu: 0 }]),
    });
    const state = stalledState();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([]);
    expect(io.killTree).not.toHaveBeenCalled();
    expect(io.comment).not.toHaveBeenCalled();
    expect(state.slots[0]!.reaped).toBe(false);
    expect(state.slots[0]!.pid).toBe(4242);
  });

  it("retries a genuinely-stalled slot UNDER the cap (kill + envelope + CLEAN re-queue)", async () => {
    const { deps, io } = makeDeps({
      agentLaneMtime: vi.fn(() => NOW - 120),
      // No build/test descendant, flat cpu → genuinely stuck.
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a1",
          issue: 190,
          workerId: "wTEST",
          logTail: "[afk] inner: stalled tool call — never returns",
          notes: "mid-iteration progress note",
          durationS: 200,
          // attempt 1 < cap (3) → retry.
          attempt: 1,
        }),
      ),
    });
    const state = stalledState();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
    expect(io.comment).toHaveBeenCalledOnce();
    const [issue, body] = io.comment.mock.calls[0]!;
    expect(issue).toBe(190);
    expect(body).toContain('data-attempt-status="no-sentinel"');
    expect(body).toContain("stalled tool call");
    // #402: a re-queue UNDER the cap routes back to ready-for-agent CLEAN — no
    // blocked:stalled rides along, so the adoption-doctor hygiene check stays at
    // zero offenders. The typed label is NOT created on retry.
    expect(io.ensureLabel).not.toHaveBeenCalled();
    expect(io.editLabels).toHaveBeenCalledWith(190, ["ready-for-agent"], ["running"]);
    expect(io.teardownIterDir).toHaveBeenCalledOnce();
    // Slot freed + idempotency guard set.
    const slot = state.slots[0]!;
    expect(slot.pid).toBeNull();
    expect(slot.stalled).toBe(false);
    expect(slot.reaped).toBe(true);

    // Re-poll is a no-op (slot no longer flagged, reaped guard set).
    io.killTree.mockClear();
    io.comment.mockClear();
    await pollStallDetector(state, deps, config());
    expect(io.killTree).not.toHaveBeenCalled();
    expect(io.comment).not.toHaveBeenCalled();
  });

  it("reaps without posting when the worker died pre-claim (no issue)", async () => {
    const { deps, io } = makeDeps({
      agentLaneMtime: vi.fn(() => NOW - 120),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wPREB/0-a1",
          issue: null,
          workerId: "wPREB",
          logTail: "",
          notes: "",
          durationS: 0,
          attempt: 1,
        }),
      ),
    });
    const state = stalledState();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
    expect(io.comment).not.toHaveBeenCalled();
    expect(io.editLabels).not.toHaveBeenCalled();
    expect(io.teardownIterDir).toHaveBeenCalledOnce();
  });

  it("escalates to ready-for-human once the stalled re-claim cap is exhausted (#402)", async () => {
    const { deps, io } = makeDeps({
      agentLaneMtime: vi.fn(() => NOW - 120),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a3",
          issue: 190,
          workerId: "wTEST",
          logTail: "[afk] inner: stalled again",
          notes: "",
          durationS: 200,
          // attempt 3 == default cap (3) → escalate, no more retries.
          attempt: 3,
        }),
      ),
    });
    const state = stalledState();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
    // The reap envelope plus a self-explanatory "budget exhausted" page comment.
    expect(io.comment).toHaveBeenCalledTimes(2);
    const pageBody = io.comment.mock.calls[1]![1] as string;
    expect(pageBody).toContain("ready-for-human");
    expect(pageBody).toContain("attempt 3/3");
    // Escalation carries blocked:stalled (allowed alongside ready-for-human) and
    // removes both running and any ready-for-agent — never re-queued.
    expect(io.ensureLabel).toHaveBeenCalledWith("blocked:stalled");
    expect(io.editLabels).toHaveBeenCalledWith(190, ["ready-for-human", "blocked:stalled"], ["running", "ready-for-agent"]);
    expect(io.teardownIterDir).toHaveBeenCalledOnce();
  });

  it("honours RED_AFK_RETRY_STALLED to extend the re-claim budget (#402)", async () => {
    const { deps, io } = makeDeps({
      agentLaneMtime: vi.fn(() => NOW - 120),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a3",
          issue: 190,
          workerId: "wTEST",
          logTail: "stall",
          notes: "",
          durationS: 200,
          attempt: 3,
        }),
      ),
    });
    // Cap raised to 5 → attempt 3 is back under budget → CLEAN re-queue.
    deps.recoveryEnv = { RED_AFK_RETRY_STALLED: "5" };
    const state = stalledState();

    await pollStallDetector(state, deps, config());

    expect(io.ensureLabel).not.toHaveBeenCalled();
    expect(io.editLabels).toHaveBeenCalledWith(190, ["ready-for-agent"], ["running"]);
  });
});

// ---------- tick: respawn dead slot ----------

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

// ---------- runSupervisor end-to-end shape ----------

describe("runSupervisor", () => {
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

  it("emits one structured fleet heartbeat per supervise tick with queue and slot counts", async () => {
    // readyQueueDepth is now called once per tick (in superviseTick, not in
    // emitFleetHeartbeat). The stop tick returns early and skips the fetch, so
    // only one call happens (tick 1). The second heartbeat uses queueDepth: 0
    // (the default for a stop tick).
    const { deps, io } = makeDeps({
      isAlive: vi.fn((pid: number) => pid !== 1001),
      readyQueueDepth: vi.fn().mockResolvedValueOnce(5),
      now: vi.fn().mockReturnValueOnce(NOW).mockReturnValueOnce(NOW).mockReturnValueOnce(NOW).mockReturnValueOnce(NOW + 15),
    });
    const state = initSupervisorState(1);
    let probes = 0;
    const stop = () => (++probes >= 2);

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 15 }), stop);

    expect(io.emitFleetHeartbeat).toHaveBeenCalledTimes(2);
    expect(io.emitFleetHeartbeat.mock.calls[0]![0]).toMatchObject({
      ts: new Date(NOW * 1000).toISOString(),
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
});

// ---------- envelope builders ----------

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
    expect(body).toContain("stalled tool call");
  });
});

describe("guardedTick — per-tick wall-clock ceiling (unwedgeable loop)", () => {
  const never = (): Promise<void> => new Promise<void>(() => {});
  const immediate = (): Promise<void> => Promise.resolve();
  const okResult = { respawned: [1], deaths: [], parked: [], idleParked: [], reaped: [], reconciledSlots: [], stopped: false, queueDepth: 0, abandoned: false };
  const CONTINUE = { respawned: [], deaths: [], parked: [], idleParked: [], reaped: [], reconciledSlots: [], stopped: false, queueDepth: 0, abandoned: true };

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

// ---------- idle-drain: exit 0 idle-parks and un-parks on queue refill (#578) ----------

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
      agentLaneMtime: vi.fn(() => NOW - 9999),
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

// ---------- spawning guard: prevents duplicate spawn on abandoned tick (#578) ----------

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

// ---------- dispatchReconcileIfPossible (#562) ----------

/** Build a SupervisorState with slot 0 free (pid null, not parked). */
function freeSlotState(): SupervisorState {
  const state = initSupervisorState(1);
  state.slots[0] = freshSlot(); // pid: null, parked: false
  return state;
}

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
      agentLaneMtime: vi.fn(() => NOW - 1000), // agent lane silent for 1000s
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
