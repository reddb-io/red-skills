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
  sweepParkedSlot,
  validateStallThresholds,
  validateSupervisorStaleThreshold,
  validateSupervisorProgressThreshold,
  classifySupervisor,
  evaluateDrainBudget,
  evaluateValidationAdmission,
  guardedTick,
  parkedSlotWorkFor,
  stalledVerdict,
  wallClockVerdict,
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

});

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

});

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

});

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

  it("resolves the per-issue wall-clock ceiling from env, then config, then default (#2286)", () => {
    // Generous default (45 min) — a runaway backstop, not a pace-setter.
    expect(resolveSupervisorConfig({}).issueWallClockMaxS).toBe(2700);
    expect(resolveSupervisorConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "3600" }).issueWallClockMaxS).toBe(3600);
    expect(
      resolveSupervisorConfig({}, (key) => (key === "afk.issue_wall_clock_max_s" ? "1800" : "")).issueWallClockMaxS,
    ).toBe(1800);
    // env wins over config.
    expect(
      resolveSupervisorConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "3600" }, (key) =>
        key === "afk.issue_wall_clock_max_s" ? "1800" : "",
      ).issueWallClockMaxS,
    ).toBe(3600);
    // 0 / garbage would reap on claim — floor back to the default.
    expect(resolveSupervisorConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "0" }).issueWallClockMaxS).toBe(2700);
    expect(resolveSupervisorConfig({ RED_AFK_ISSUE_WALL_CLOCK_MAX_S: "bad" }).issueWallClockMaxS).toBe(2700);
  });

  it("resolves the drain USD budget from env or config and rejects typo values", () => {
    expect(resolveSupervisorConfig({}).drainBudgetUsd).toBeUndefined();
    expect(resolveSupervisorConfig({ RED_AFK_DRAIN_MAX_COST_USD: "12.50" }).drainBudgetUsd).toBe(12.5);
    expect(resolveSupervisorConfig({}, (key) => (key === "afk.drain.max_cost_usd" ? "9.25" : ""))).toMatchObject({
      drainBudgetUsd: 9.25,
    });
    expect(resolveSupervisorConfig({ RED_AFK_DRAIN_MAX_COST_USD: "0" }).drainBudgetUsd).toBeUndefined();
    expect(resolveSupervisorConfig({}, () => "not-a-number").drainBudgetUsd).toBeUndefined();
  });
});

describe("evaluateDrainBudget", () => {
  it("is undefined when no budget is configured", () => {
    expect(evaluateDrainBudget(10, undefined)).toBeUndefined();
  });

  it("classifies exact OK/WARNING/CRITICAL/HARD_STOP tier boundaries", () => {
    expect(evaluateDrainBudget(7.49, 10)?.tier).toBe("OK");
    expect(evaluateDrainBudget(7.5, 10)?.tier).toBe("WARNING");
    expect(evaluateDrainBudget(8.99, 10)?.tier).toBe("WARNING");
    expect(evaluateDrainBudget(9, 10)?.tier).toBe("CRITICAL");
    expect(evaluateDrainBudget(9.99, 10)?.tier).toBe("CRITICAL");
    expect(evaluateDrainBudget(10, 10)?.tier).toBe("HARD_STOP");
    expect(evaluateDrainBudget(12, 10)?.tier).toBe("HARD_STOP");
  });
});

describe("evaluateValidationAdmission (#1758)", () => {
  it("serializes known-heavy validation and checks available memory before admission", () => {
    expect(evaluateValidationAdmission({
      knownHeavy: false,
      activeHeavyValidations: 5,
      availableMemoryMb: 0,
      minAvailableMemoryMb: 4096,
    })).toEqual({ admit: true, reason: "not-heavy" });

    expect(evaluateValidationAdmission({
      knownHeavy: true,
      activeHeavyValidations: 1,
      availableMemoryMb: 8192,
      minAvailableMemoryMb: 4096,
    })).toEqual({ admit: false, reason: "serialize-heavy-validation" });

    expect(evaluateValidationAdmission({
      knownHeavy: true,
      activeHeavyValidations: 0,
      availableMemoryMb: 2048,
      minAvailableMemoryMb: 4096,
    })).toEqual({ admit: false, reason: "insufficient-memory" });

    expect(evaluateValidationAdmission({
      knownHeavy: true,
      activeHeavyValidations: 0,
      availableMemoryMb: 8192,
      minAvailableMemoryMb: 4096,
    })).toEqual({ admit: true, reason: "admit" });
  });
});

describe("guardedTick — abandoned flag", () => {
  it("sets abandoned:false on a tick that completes normally", async () => {
    const tick = vi.fn(async () => ({
      respawned: [],
      deaths: [],
      parked: [],
      idleParked: [],
      halfOpened: [],
      reaped: [],
      crashReconciled: [],
      reconciledSlots: [],
      retiredSlots: [],
      runnerChanged: false,
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

describe("circuit trip and sweep", () => {
  it("trips after K fast clean boot deaths while the queue still has work", async () => {
    const { deps, io } = makeDeps();
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.deaths = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
    slot.spawnEpoch = NOW - 5;
    io.lastExitCode.mockReturnValue(0);

    const { parked } = await handleDeadSlot(0, slot, deps, config(), 1);

    expect(parked).toBe(true);
    expect(slot.parked).toBe(true);
    expect(slot.deaths).toEqual([NOW - 40, NOW - 30, NOW - 20, NOW - 10, NOW]);
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });

  it("parks a fatal host-config death without retrying or feeding the fast-death circuit", async () => {
    const { deps, io } = makeDeps();
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.deaths = [NOW - 40, NOW - 30, NOW - 20, NOW - 10];
    slot.spawnEpoch = NOW - 5;
    io.lastExitCode.mockReturnValue(78);

    const { parked } = await handleDeadSlot(0, slot, deps, config());

    expect(parked).toBe(true);
    expect(slot.parked).toBe(true);
    expect(slot.fatalReason).toBe("host-config");
    expect(slot.deaths).toEqual([NOW - 40, NOW - 30, NOW - 20, NOW - 10]);
    expect(slot.swept).toBe(false);
    expect(io.spawnSlot).not.toHaveBeenCalled();
    expect(io.parkedSlotWork).not.toHaveBeenCalled();
    expect(io.logLines).toContainEqual(expect.stringContaining("fatal host configuration"));
  });

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
    expect(io.comment).toHaveBeenCalledTimes(2);
    const [issue, body] = io.comment.mock.calls.find((call) =>
      String(call[1]).includes('data-attempt-status="discarded"'),
    )!;
    expect(issue).toBe(7);
    expect(body).toContain('data-attempt-status="discarded"');
    expect(io.comment.mock.calls.some((call) => String(call[1]).includes("kind=concede"))).toBe(true);
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
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
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

  it("forwards the soft AND hard-silence thresholds to the liveness verdict (#2203 wiring)", async () => {
    // Locks the backstop wiring: the reaper must pass stallKillThresholdS as
    // laneHardIdleMs so a hung worker with a live child is still flagged stalled.
    // A refactor that drops the 3rd arg silently disables the #2203 fix.
    const verdict = vi.fn((): LivenessVerdict => stalledVerdict(120));
    const { deps } = makeDeps({
      workerLivenessVerdict: verdict,
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "vitest", cpu: 0 }]),
    });
    const cfg = config();

    await pollStallDetector(stalledState(), deps, cfg);

    expect(verdict).toHaveBeenCalledWith(
      0,
      cfg.stallThresholdS * 1000,
      cfg.stallKillThresholdS * 1000,
      cfg.issueWallClockMaxS * 1000,
    );
  });

  it("forwards the per-issue wall-clock ceiling to the liveness verdict (#2286 wiring)", async () => {
    // Wiring lock: issueWallClockMaxMs must arrive as issueWallClockMaxS * 1000.
    // A refactor that drops the 4th arg silently disables the age-based ceiling.
    const verdict = vi.fn((): LivenessVerdict => stalledVerdict(120));
    const { deps } = makeDeps({
      workerLivenessVerdict: verdict,
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "vitest", cpu: 0 }]),
    });
    const cfg = config({ issueWallClockMaxS: 1800 });

    await pollStallDetector(stalledState(), deps, cfg);

    expect(verdict).toHaveBeenCalledWith(0, cfg.stallThresholdS * 1000, cfg.stallKillThresholdS * 1000, 1_800_000);
  });

  it("reaps a wall-clock-exceeded slot on the SAME tick it is first flagged (#2286)", async () => {
    // The ceiling is its own deadline: the attempt already spent its budget, so
    // the reaper must not wait out a second, silence-shaped countdown it would
    // never accumulate behind a fresh lane. The kill still goes through
    // decideReaperSignal.
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => wallClockVerdict(3_000)),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a1",
          issue: 190,
          workerId: "wTEST",
          branch: "afk/wTEST/190-some-work",
          logTail: "[afk] inner: still editing, never converging",
          notes: "",
          durationS: 3000,
          attempt: 1,
        }),
      ),
      attemptBranchHead: vi.fn(async () => "aaa111"),
    });
    // Never previously flagged: the ceiling fires on first detection.
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 4242;
    slot.spawnEpoch = NOW - 3_000;

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
  });

  it("retries a genuinely-stalled slot UNDER the cap (kill + envelope + CLEAN re-queue)", async () => {
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
      // No build/test descendant, flat cpu → genuinely stuck.
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a1",
          issue: 190,
          workerId: "wTEST",
          branch: "afk/wTEST/190-some-work",
          logTail: "[afk] inner: stalled tool call — never returns",
          notes: "mid-iteration progress note",
          durationS: 200,
          // attempt 1 < cap (3) → retry.
          attempt: 1,
        }),
      ),
      attemptBranchHead: vi.fn(async () => "aaa111"),
    });
    const state = stalledState();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
    expect(io.comment).toHaveBeenCalledTimes(2);
    const [issue, body] = io.comment.mock.calls.find((call) =>
      String(call[1]).includes('data-attempt-status="no-sentinel"'),
    )!;
    expect(issue).toBe(190);
    expect(body).toContain('data-attempt-status="no-sentinel"');
    expect(body).toContain("stalled tool call");
    expect(io.comment.mock.calls.some((call) => String(call[1]).includes("kind=concede"))).toBe(true);
    // #1197: the retry first opens a bounded contest window. The issue is not
    // ready-for-agent yet, so a second worker cannot double-run it while the
    // original branch may still report late commits.
    expect(io.ensureLabel).not.toHaveBeenCalled();
    expect(io.editLabels).toHaveBeenCalledWith(190, ["contested"], []);
    expect(state.slots[0]!.contest?.issue).toBe(190);
    expect(io.logLines.some((line) => line.includes("opened"))).toBe(true);
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

  it("resolves a contest as reclaimed when the original branch advances inside the window", async () => {
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.contest = {
      issue: 190,
      branch: "afk/wTEST/190-some-work",
      headAtReap: "aaa111",
      openedEpoch: NOW - 5,
      deadlineEpoch: NOW + 25,
    };
    const { deps, io } = makeDeps({
      attemptBranchHead: vi.fn(async () => "bbb222"),
    });

    const result = await resolveReapContest(0, slot, deps, config());

    expect(result).toBe("reclaimed");
    expect(slot.contest).toBeNull();
    expect(io.editLabels).toHaveBeenCalledWith(190, [], ["contested"]);
    expect(io.logLines.some((line) => line.includes("reclaimed"))).toBe(true);
  });

  it("resolves a contest as expired and applies the normal clean requeue after the window", async () => {
    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.contest = {
      issue: 190,
      branch: "afk/wTEST/190-some-work",
      headAtReap: "aaa111",
      openedEpoch: NOW - 40,
      deadlineEpoch: NOW - 10,
    };
    const { deps, io } = makeDeps({
      attemptBranchHead: vi.fn(async () => "aaa111"),
    });

    const result = await resolveReapContest(0, slot, deps, config());

    expect(result).toBe("expired");
    expect(slot.contest).toBeNull();
    expect(io.editLabels).toHaveBeenCalledWith(190, ["ready-for-agent"], ["running", "contested"]);
    expect(io.logLines.some((line) => line.includes("expired"))).toBe(true);
  });

  it("does NOT tear down the worktree when the worker survives the kill (#580)", async () => {
    // killTree reports `false` (survived SIGKILL). The slot is still freed and
    // labels rotate, but the destructive `rm -rf` teardown is skipped so it can
    // never race a still-live worker still writing into the worktree.
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      killTree: vi.fn(async () => false),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a1",
          issue: 190,
          workerId: "wTEST",
          logTail: "stalled but SIGTERM-ignoring",
          notes: "",
          durationS: 200,
          attempt: 1,
        }),
      ),
    });
    const state = stalledState();

    const reaped = await pollStallDetector(state, deps, config());

    expect(reaped).toEqual([0]);
    expect(io.killTree).toHaveBeenCalledWith(4242);
    // Teardown is gated on confirmed death — a survivor leaks its worktree
    // rather than getting rm -rf'd out from under itself.
    expect(io.teardownIterDir).not.toHaveBeenCalled();
    // Slot still freed so the fleet keeps making progress.
    expect(state.slots[0]!.pid).toBeNull();
    expect(state.slots[0]!.reaped).toBe(true);
  });

  it("tears down the worktree when killTree confirms death (#580)", async () => {
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
      inspectTree: vi.fn((): readonly ProcessSnapshotEntry[] => [{ command: "node", cpu: 0 }]),
      killTree: vi.fn(async () => true),
      resolveIterDir: vi.fn(
        (): IterDirInfo => ({
          path: "/w/wTEST/190-a1",
          issue: 190,
          workerId: "wTEST",
          logTail: "stalled, killed cleanly",
          notes: "",
          durationS: 200,
          attempt: 1,
        }),
      ),
    });
    const state = stalledState();

    await pollStallDetector(state, deps, config());

    expect(io.killTree).toHaveBeenCalledWith(4242);
    expect(io.teardownIterDir).toHaveBeenCalledOnce();
  });

  it("reaps without posting when the worker died pre-claim (no issue)", async () => {
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
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
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
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
    expect(io.comment).toHaveBeenCalledTimes(3);
    const pageBody = io.comment.mock.calls.find((call) =>
      String(call[1]).includes("ready-for-human"),
    )![1] as string;
    expect(pageBody).toContain("ready-for-human");
    expect(pageBody).toContain("attempt 3/3");
    // Escalation carries blocked:stalled (allowed alongside ready-for-human) and
    // removes both running and any ready-for-agent — never re-queued. The shed
    // set is the PLANNER's since #2663, so it is emitted in state-role order
    // (`ready-for-agent` before the `running` projection).
    expect(io.ensureLabel).toHaveBeenCalledWith("blocked:stalled");
    expect(io.editLabels).toHaveBeenCalledWith(190, ["ready-for-human", "blocked:stalled"], ["ready-for-agent", "running"]);
    expect(io.teardownIterDir).toHaveBeenCalledOnce();
  });

  it("honours RED_AFK_RETRY_STALLED to extend the re-claim budget (#402)", async () => {
    const { deps, io } = makeDeps({
      workerLivenessVerdict: vi.fn((): LivenessVerdict => stalledVerdict(120)),
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
