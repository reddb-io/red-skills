import { describe, expect, it, vi } from "vitest";
import {
  buildDiscardEnvelope,
  buildReaperEnvelope,
  computeStalled,
  handleDeadSlot,
  initSupervisorState,
  pollStallDetector,
  recordDeath,
  resolveSupervisorConfig,
  runSupervisor,
  sweepParkedSlot,
  superviseTick,
  validateStallThresholds,
  type IterDirInfo,
  type SupervisorConfig,
  type SupervisorDeps,
  type SweepWork,
} from "../src/core/supervisor.js";
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
    ...over,
  };
}

interface FakeIo {
  spawnSlot: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  inspectTree: ReturnType<typeof vi.fn>;
  sleep: ReturnType<typeof vi.fn>;
  agentLaneMtime: ReturnType<typeof vi.fn>;
  resolveIterDir: ReturnType<typeof vi.fn>;
  teardownIterDir: ReturnType<typeof vi.fn>;
  parkedSlotWork: ReturnType<typeof vi.fn>;
  removeDir: ReturnType<typeof vi.fn>;
  comment: ReturnType<typeof vi.fn>;
  editLabels: ReturnType<typeof vi.fn>;
  ensureRunnerErrorLabel: ReturnType<typeof vi.fn>;
  ensureLabel: ReturnType<typeof vi.fn>;
  now: ReturnType<typeof vi.fn>;
}

function makeDeps(over: Partial<Record<keyof FakeIo, unknown>> = {}): {
  deps: SupervisorDeps;
  io: FakeIo;
} {
  let nextPid = 1000;
  const io: FakeIo = {
    spawnSlot: vi.fn(async () => ({ pid: ++nextPid, spawnEpoch: NOW })),
    isAlive: vi.fn(() => true),
    killTree: vi.fn(async () => {}),
    inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => []),
    sleep: vi.fn(async () => {}),
    agentLaneMtime: vi.fn(() => 0),
    resolveIterDir: vi.fn((): IterDirInfo | null => null),
    teardownIterDir: vi.fn(async () => {}),
    parkedSlotWork: vi.fn(
      (): SweepWork => ({ workers: [], fastDeaths: 0, supervisorLogPath: ".red/tmp/afk-supervisor.log" }),
    ),
    removeDir: vi.fn(async () => {}),
    comment: vi.fn(async () => {}),
    editLabels: vi.fn(async () => {}),
    ensureRunnerErrorLabel: vi.fn(async () => {}),
    ensureLabel: vi.fn(async () => {}),
    now: vi.fn(() => NOW),
    ...(over as Partial<FakeIo>),
  };
  const deps: SupervisorDeps = {
    proc: {
      spawnSlot: io.spawnSlot,
      isAlive: io.isAlive,
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
    },
    now: io.now,
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

// ---------- resolveSupervisorConfig ----------

describe("resolveSupervisorConfig", () => {
  it("uses defaults for an empty env", () => {
    const c = resolveSupervisorConfig({});
    expect(c).toMatchObject({ target: 2, circuitK: 5, stallThresholdS: 600, stallKillThresholdS: 1800, runner: "claude" });
  });

  it("honours numeric overrides and ignores garbage", () => {
    const c = resolveSupervisorConfig({ RED_AFK_TARGET: "4", RED_AFK_CIRCUIT_K: "nope", RED_AFK_RUNNER: "codex" });
    expect(c.target).toBe(4);
    expect(c.circuitK).toBe(5);
    expect(c.runner).toBe("codex");
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
          fastDeaths: 5,
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

  it("sweep is idempotent and cleans dirs with no claimed issue without posting", async () => {
    const { deps, io } = makeDeps({
      parkedSlotWork: vi.fn(
        (): SweepWork => ({
          workers: [{ workerId: "wDDDD", pairs: [{ dir: "/w/wDDDD/1-a1", issue: null }] }],
          fastDeaths: 5,
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

  it("DOES reap a genuinely-stalled slot (kill + envelope + label rotate)", async () => {
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
    // ADDITIVE typed-blocked tag: routing unchanged (ready-for-agent restored)
    // with blocked:stalled appended; the typed label is created on the fly.
    expect(io.ensureLabel).toHaveBeenCalledWith("blocked:stalled");
    expect(io.editLabels).toHaveBeenCalledWith(190, ["ready-for-agent", "blocked:stalled"], ["running"]);
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
    // Stopped on the first tick → no inter-tick sleep happened.
    expect(io.sleep).not.toHaveBeenCalled();
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

    // Exactly one inter-tick sleep, at the configured cadence (15s → 15000ms).
    expect(io.sleep).toHaveBeenCalledTimes(1);
    expect(io.sleep).toHaveBeenCalledWith(15000);
  });

  it("honours a non-default poll cadence", async () => {
    const { deps, io } = makeDeps({ isAlive: vi.fn(() => true) });
    const state = initSupervisorState(1);
    let probes = 0;
    const stop = () => (++probes >= 2);

    await runSupervisor(state, deps, config({ target: 1, pollIntervalS: 7 }), stop);

    expect(io.sleep).toHaveBeenCalledTimes(1);
    expect(io.sleep).toHaveBeenCalledWith(7000);
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
    });
    expect(body).toContain('data-attempt-status="no-sentinel"');
    expect(body).toContain("worker `wTEST`");
    expect(body).toContain('data-section="notes"');
    expect(body).toContain('data-section="log"');
    expect(body).toContain("stalled tool call");
  });
});
