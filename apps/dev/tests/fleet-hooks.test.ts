import { describe, expect, it, vi } from "vitest";
import {
  freshSlot,
  handleDeadSlot,
  initSupervisorState,
  pollStallDetector,
  runSupervisor,
  superviseTick,
  sweepParkedSlot,
  type IterDirInfo,
  type ReconcileCandidate,
  type SupervisorConfig,
  type SupervisorDeps,
  type SupervisorState,
  type SweepWork,
} from "../src/core/supervisor.js";
import {
  deriveFleetHookEnv,
  dispatchFleetHook,
  type FleetHookContext,
  type FleetHookDispatchResult,
} from "../src/core/fleet-hook-dispatcher.js";
import {
  FLEET_HOOK_NAMES,
  FLEET_HOOK_EXIT_POLICY,
  resolveFleetHooks,
  type FleetHookName,
} from "../src/core/fleet-hook-config.js";
import type { ProcessSnapshotEntry } from "../src/core/reaper-signal.js";
import type { HookExec } from "../src/core/hook-dispatcher.js";
import type { LivenessVerdict } from "@reddb-io/red-castle";

const NOW = 1700000000;

// ---------- helpers ----------

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
    eventFallbackS: 60,
    tickTimeoutS: 120,
    supervisorStaleS: 300,
    progressStaleS: 900,
    halfOpenBaseS: 60,
    halfOpenCapS: 3600,
    unblockSweepIntervalS: 60,
    supervisorMaxRestarts: 5,
    supervisorRestartWindowS: 300,
    ...over,
  };
}

function makeFleetHookResult(over: Partial<FleetHookDispatchResult> = {}): FleetHookDispatchResult {
  return { aborted: false, vetoed: false, executions: [], ...over };
}

interface FakeIo {
  spawnSlot: ReturnType<typeof vi.fn>;
  spawnReconcileWorker: ReturnType<typeof vi.fn>;
  isAlive: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  inspectTree: ReturnType<typeof vi.fn>;
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
  dispatchFleetHook: ReturnType<typeof vi.fn>;
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
    sleep: vi.fn((_ms: number) => new Promise<void>((resolve) => setTimeout(resolve, 0))),
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
    crashedClaimState: vi.fn(async () => null),
    emitFleetHeartbeat: vi.fn(async () => {}),
    dispatchFleetHook: vi.fn(async () => makeFleetHookResult()),
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
      workerLivenessVerdict: io.workerLivenessVerdict,
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
      crashedClaimState: io.crashedClaimState,
    },
    now: io.now,
    emitFleetHeartbeat: io.emitFleetHeartbeat,
    dispatchFleetHook: io.dispatchFleetHook,
  };
  return { deps, io };
}

// ---------- deriveFleetHookEnv ----------

describe("deriveFleetHookEnv", () => {
  const base = { RED_AFK_ROOT: "/repo", RED_AFK_REPO: "owner/repo" };

  it("always sets RED_AFK_FLEET_EVENT and RED_AFK_RUNNER", () => {
    const ctx: FleetHookContext = { event: "pre_fleet", runner: "claude" };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_EVENT).toBe("pre_fleet");
    expect(env.RED_AFK_RUNNER).toBe("claude");
  });

  it("inherits base env fields", () => {
    const ctx: FleetHookContext = { event: "post_fleet", runner: "codex" };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_ROOT).toBe("/repo");
    expect(env.RED_AFK_REPO).toBe("owner/repo");
  });

  it("sets slot env when slot is present", () => {
    const ctx: FleetHookContext = { event: "on_slot_spawn", runner: "claude", slot: 2 };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_SLOT).toBe("2");
  });

  it("omits slot env when slot is absent", () => {
    const ctx: FleetHookContext = { event: "pre_fleet", runner: "claude" };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_SLOT).toBeUndefined();
  });

  it("sets pid env when pid is a positive number", () => {
    const ctx: FleetHookContext = { event: "on_slot_death", runner: "claude", slot: 0, pid: 42 };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_PID).toBe("42");
  });

  it("omits pid env when pid is 0", () => {
    const ctx: FleetHookContext = { event: "on_slot_death", runner: "claude", slot: 0, pid: 0 };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_PID).toBeUndefined();
  });

  it("sets circuit-trip fields", () => {
    const ctx: FleetHookContext = {
      event: "on_circuit_trip",
      runner: "claude",
      slot: 1,
      worker_ids: "wAAA,wBBB",
      death_count: 5,
      supervisor_log: ".red/tmp/afk-supervisor.log",
    };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_WORKER_IDS).toBe("wAAA,wBBB");
    expect(env.RED_AFK_FLEET_DEATH_COUNT).toBe("5");
    expect(env.RED_AFK_FLEET_SUPERVISOR_LOG).toBe(".red/tmp/afk-supervisor.log");
  });

  it("sets stall fields", () => {
    const ctx: FleetHookContext = {
      event: "on_stall_reap",
      runner: "claude",
      slot: 0,
      idle_seconds: 1900,
      stall_since: NOW - 1900,
    };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_IDLE_SECONDS).toBe("1900");
    expect(env.RED_AFK_FLEET_STALL_SINCE).toBe(String(NOW - 1900));
  });

  it("omits stall_since when 0", () => {
    const ctx: FleetHookContext = { event: "on_stall_detected", runner: "claude", stall_since: 0 };
    const env = deriveFleetHookEnv(base, ctx);
    expect(env.RED_AFK_FLEET_STALL_SINCE).toBeUndefined();
  });
});

// ---------- dispatchFleetHook ----------

describe("dispatchFleetHook — exit-code policy", () => {
  function fakeExec(code: number, stdout = ""): HookExec {
    return async () => ({ code, stdout });
  }

  it("pre_fleet: non-zero returns aborted=true", async () => {
    const ctx: FleetHookContext = { event: "pre_fleet", runner: "claude" };
    const result = await dispatchFleetHook("pre_fleet", ["fail-cmd"], ctx, fakeExec(1));
    expect(result.aborted).toBe(true);
    expect(result.vetoed).toBe(false);
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0]!.rc).toBe(1);
  });

  it("pre_fleet: zero exit returns aborted=false", async () => {
    const ctx: FleetHookContext = { event: "pre_fleet", runner: "claude" };
    const result = await dispatchFleetHook("pre_fleet", ["ok-cmd"], ctx, fakeExec(0));
    expect(result.aborted).toBe(false);
    expect(result.vetoed).toBe(false);
  });

  it("pre_fleet: halts after first non-zero (abort policy)", async () => {
    let calls = 0;
    const exec: HookExec = async () => { calls++; return { code: 1, stdout: "" }; };
    const ctx: FleetHookContext = { event: "pre_fleet", runner: "claude" };
    await dispatchFleetHook("pre_fleet", ["cmd1", "cmd2"], ctx, exec);
    expect(calls).toBe(1);
  });

  it("on_stall_reap: non-zero returns vetoed=true", async () => {
    const ctx: FleetHookContext = { event: "on_stall_reap", runner: "claude", slot: 0 };
    const result = await dispatchFleetHook("on_stall_reap", ["veto-cmd"], ctx, fakeExec(1));
    expect(result.vetoed).toBe(true);
    expect(result.aborted).toBe(false);
  });

  it("on_stall_reap: first non-zero stops remaining commands", async () => {
    let calls = 0;
    const exec: HookExec = async () => { calls++; return { code: 1, stdout: "" }; };
    const ctx: FleetHookContext = { event: "on_stall_reap", runner: "claude", slot: 0 };
    await dispatchFleetHook("on_stall_reap", ["veto-cmd", "never-runs"], ctx, exec);
    expect(calls).toBe(1);
  });

  it("on_stall_reap: zero exit is not a veto", async () => {
    const ctx: FleetHookContext = { event: "on_stall_reap", runner: "claude", slot: 0 };
    const result = await dispatchFleetHook("on_stall_reap", ["ok-cmd"], ctx, fakeExec(0));
    expect(result.vetoed).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it("on_circuit_trip: non-zero logs and continues (continue policy)", async () => {
    let calls = 0;
    const exec: HookExec = async () => { calls++; return { code: calls === 1 ? 1 : 0, stdout: "" }; };
    const ctx: FleetHookContext = { event: "on_circuit_trip", runner: "claude", slot: 0 };
    const result = await dispatchFleetHook("on_circuit_trip", ["fail-cmd", "ok-cmd"], ctx, exec);
    expect(calls).toBe(2);
    expect(result.aborted).toBe(false);
    expect(result.vetoed).toBe(false);
    expect(result.executions).toHaveLength(2);
  });

  it("empty command list returns no-op result", async () => {
    const exec: HookExec = async () => { throw new Error("should not run"); };
    const ctx: FleetHookContext = { event: "on_respawn", runner: "claude" };
    const result = await dispatchFleetHook("on_respawn", [], ctx, exec);
    expect(result.aborted).toBe(false);
    expect(result.vetoed).toBe(false);
    expect(result.executions).toHaveLength(0);
  });

  it("receives fleet context as stdin JSON", async () => {
    let capturedStdin: string | undefined;
    const exec: HookExec = async (_cmd, _env, stdinJson) => {
      capturedStdin = stdinJson;
      return { code: 0, stdout: "" };
    };
    const ctx: FleetHookContext = {
      event: "on_circuit_trip",
      runner: "claude",
      slot: 2,
      worker_ids: "wAAA",
      death_count: 3,
    };
    await dispatchFleetHook("on_circuit_trip", ["cmd"], ctx, exec);
    expect(capturedStdin).toBeDefined();
    const parsed = JSON.parse(capturedStdin!) as FleetHookContext;
    expect(parsed.event).toBe("on_circuit_trip");
    expect(parsed.slot).toBe(2);
    expect(parsed.worker_ids).toBe("wAAA");
    expect(parsed.death_count).toBe(3);
  });

  it("receives fleet env overlay", async () => {
    let capturedEnv: Record<string, string> | undefined;
    const exec: HookExec = async (_cmd, env) => {
      capturedEnv = env;
      return { code: 0, stdout: "" };
    };
    const ctx: FleetHookContext = { event: "on_slot_spawn", runner: "claude", slot: 1, pid: 999 };
    await dispatchFleetHook("on_slot_spawn", ["cmd"], ctx, exec, {
      env: { RED_AFK_ROOT: "/repo" },
    });
    expect(capturedEnv!.RED_AFK_FLEET_EVENT).toBe("on_slot_spawn");
    expect(capturedEnv!.RED_AFK_FLEET_SLOT).toBe("1");
    expect(capturedEnv!.RED_AFK_FLEET_PID).toBe("999");
    expect(capturedEnv!.RED_AFK_RUNNER).toBe("claude");
    expect(capturedEnv!.RED_AFK_ROOT).toBe("/repo");
  });

  it("logs fleet hook enter and exit for successful commands", async () => {
    const logs: string[] = [];
    const ctx: FleetHookContext = { event: "on_slot_spawn", runner: "claude", slot: 1, pid: 999 };
    await dispatchFleetHook("on_slot_spawn", ["notify-fleet"], ctx, async () => ({ code: 0, stdout: "" }), {
      log: (line) => logs.push(line),
    });
    expect(logs).toEqual([
      "[afk:fleet-hooks] on_slot_spawn: enter: notify-fleet",
      "[afk:fleet-hooks] on_slot_spawn: exit rc=0: notify-fleet",
    ]);
  });
});

// ---------- FLEET_HOOK_EXIT_POLICY ----------

describe("FLEET_HOOK_EXIT_POLICY", () => {
  it("pre_fleet is abort", () => {
    expect(FLEET_HOOK_EXIT_POLICY.pre_fleet).toBe("abort");
  });

  it("all on_* hooks are continue", () => {
    const onHooks = FLEET_HOOK_NAMES.filter((n) => n.startsWith("on_"));
    for (const name of onHooks) {
      expect(FLEET_HOOK_EXIT_POLICY[name]).toBe("continue");
    }
  });

  it("post_fleet is continue", () => {
    expect(FLEET_HOOK_EXIT_POLICY.post_fleet).toBe("continue");
  });
});

// ---------- resolveFleetHooks ----------

describe("resolveFleetHooks", () => {
  it("returns empty command list when no dirs are set", () => {
    const resolved = resolveFleetHooks({});
    for (const name of FLEET_HOOK_NAMES) {
      expect(resolved[name]).toEqual([]);
    }
  });

  it("returns empty when dirs exist but have no per-point subdirectories", () => {
    const resolved = resolveFleetHooks({
      libraryHooksDir: "/nonexistent/lib",
      projectHooksDir: "/nonexistent/proj",
      dirExists: () => false,
    });
    for (const name of FLEET_HOOK_NAMES) {
      expect(resolved[name]).toEqual([]);
    }
  });

  it("picks up scripts from the library dir for a given point", () => {
    const resolved = resolveFleetHooks({
      libraryHooksDir: "/lib",
      dirExists: (dir) => dir === "/lib/on_stall_reap",
      listFiles: (dir) => (dir === "/lib/on_stall_reap" ? ["10-notify.sh"] : []),
    });
    expect(resolved.on_stall_reap).toEqual(["/lib/on_stall_reap/10-notify.sh"]);
    expect(resolved.pre_fleet).toEqual([]);
  });

  it("project scripts shadow library scripts with the same filename", () => {
    const resolved = resolveFleetHooks({
      libraryHooksDir: "/lib",
      projectHooksDir: "/proj",
      dirExists: (dir) =>
        dir === "/lib/on_circuit_trip" || dir === "/proj/on_circuit_trip",
      listFiles: (dir) => {
        if (dir === "/lib/on_circuit_trip") return ["notify.sh"];
        if (dir === "/proj/on_circuit_trip") return ["notify.sh"];
        return [];
      },
    });
    // Project wins: /proj/on_circuit_trip/notify.sh shadows /lib version.
    expect(resolved.on_circuit_trip).toEqual(["/proj/on_circuit_trip/notify.sh"]);
  });
});

// ---------- supervisor integration: on_stall_reap veto ----------

describe("supervisor: on_stall_reap veto", () => {
  it("skips reapStalledSlot when on_stall_reap hook vetoes (non-zero exit)", async () => {
    const dispatchFleetHookFn = vi.fn(async (name: FleetHookName) => {
      if (name === "on_stall_reap") return makeFleetHookResult({ vetoed: true });
      return makeFleetHookResult();
    });

    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });
    // Override isAlive to always say the pid is alive (slot occupied).
    io.isAlive.mockReturnValue(true);
    // inspectTree: no active descendants, flat cpu → reaper would normally kill.
    io.inspectTree.mockReturnValue([]);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 999;
    slot.spawnEpoch = NOW - 200; // spawned long ago
    slot.stalled = true;
    slot.stallSinceEpoch = NOW - 200; // stalled for 200s > stallKillThresholdS(90)

    const cfg = config({ stallThresholdS: 30, stallKillThresholdS: 90 });
    // workerLivenessVerdict returns stalled to keep the slot flagged.
    io.workerLivenessVerdict.mockReturnValue({ status: "stalled", laneFresh: false, laneAgeMs: 200_000, crossCheckArmed: true, liveDescendants: false, reason: "lane idle" });

    await pollStallDetector(state, deps, cfg);

    // Hook vetoed → killTree must NOT have been called.
    expect(io.killTree).not.toHaveBeenCalled();
    expect(dispatchFleetHookFn).toHaveBeenCalledWith("on_stall_reap", expect.objectContaining({
      event: "on_stall_reap",
      slot: 0,
      pid: 999,
    }));
  });

  it("reaps slot when on_stall_reap hook allows (zero exit)", async () => {
    const dispatchFleetHookFn = vi.fn(async () => makeFleetHookResult());

    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });
    io.isAlive.mockReturnValueOnce(true).mockReturnValue(false);
    io.killTree.mockResolvedValue(true);
    io.inspectTree.mockReturnValue([]);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 999;
    slot.spawnEpoch = NOW - 200;
    slot.stalled = true;
    slot.stallSinceEpoch = NOW - 200;

    const cfg = config({ stallThresholdS: 30, stallKillThresholdS: 90 });
    io.workerLivenessVerdict.mockReturnValue({ status: "stalled", laneFresh: false, laneAgeMs: 200_000, crossCheckArmed: true, liveDescendants: false, reason: "lane idle" });

    const reaped = await pollStallDetector(state, deps, cfg);

    // No veto → reap happened.
    expect(reaped).toContain(0);
    expect(io.killTree).toHaveBeenCalledWith(999);
  });

  it("reaps slot when dispatchFleetHook is absent (default unchanged behavior)", async () => {
    // deps without dispatchFleetHook
    const { deps, io } = makeDeps({ dispatchFleetHook: undefined });
    io.isAlive.mockReturnValueOnce(true).mockReturnValue(false);
    io.killTree.mockResolvedValue(true);
    io.inspectTree.mockReturnValue([]);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 999;
    slot.spawnEpoch = NOW - 200;
    slot.stalled = true;
    slot.stallSinceEpoch = NOW - 200;

    const cfg = config({ stallThresholdS: 30, stallKillThresholdS: 90 });
    io.workerLivenessVerdict.mockReturnValue({ status: "stalled", laneFresh: false, laneAgeMs: 200_000, crossCheckArmed: true, liveDescendants: false, reason: "lane idle" });

    const reaped = await pollStallDetector(state, deps, cfg);

    // Absent hook → reap happens as before.
    expect(reaped).toContain(0);
    expect(io.killTree).toHaveBeenCalledWith(999);
  });
});

// ---------- supervisor integration: on_circuit_trip ----------

describe("supervisor: on_circuit_trip", () => {
  it("fires on_circuit_trip with slot/worker-ids/death-count context", async () => {
    const dispatchFleetHookFn = vi.fn(async (_n: FleetHookName, _c: FleetHookContext) => makeFleetHookResult());
    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });

    // sweepParkedSlot resolves worker IDs from parkedSlotWork.
    io.parkedSlotWork.mockReturnValue({
      workers: [{ workerId: "wAAA", pairs: [{ dir: "/tmp/wAAA/42-a1", issue: 42 }] }],
      supervisorLogPath: ".red/tmp/afk-supervisor.log",
    });

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    // Pre-trip: circuit ring holds 5 fast deaths.
    slot.deaths = [NOW - 5, NOW - 4, NOW - 3, NOW - 2, NOW - 1];
    slot.pid = 77;

    await sweepParkedSlot(0, slot, deps, config());

    const tripCall = dispatchFleetHookFn.mock.calls.find(
      ([name]) => name === "on_circuit_trip",
    );
    expect(tripCall).toBeDefined();
    const [, ctx] = tripCall! as [FleetHookName, FleetHookContext];
    expect(ctx.event).toBe("on_circuit_trip");
    expect(ctx.slot).toBe(0);
    expect(ctx.death_count).toBe(5);
    expect(ctx.worker_ids).toBe("wAAA");
    expect(ctx.supervisor_log).toBe(".red/tmp/afk-supervisor.log");
  });

  it("fires on_circuit_trip even when no workers found (circuit still tripped)", async () => {
    const dispatchFleetHookFn = vi.fn(async (_n: FleetHookName, _c: FleetHookContext) => makeFleetHookResult());
    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });
    io.parkedSlotWork.mockReturnValue({ workers: [], supervisorLogPath: ".red/tmp/afk-supervisor.log" });

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.deaths = [NOW - 1, NOW - 2, NOW - 3, NOW - 4, NOW - 5];

    await sweepParkedSlot(0, slot, deps, config());

    const tripCall = dispatchFleetHookFn.mock.calls.find(([n]) => n === "on_circuit_trip");
    expect(tripCall).toBeDefined();
  });

  it("does not fire on_circuit_trip when dispatchFleetHook is absent", async () => {
    const { deps, io } = makeDeps({ dispatchFleetHook: undefined });
    io.parkedSlotWork.mockReturnValue({ workers: [], supervisorLogPath: ".red/tmp/afk-supervisor.log" });

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    // Should not throw when dispatchFleetHook is absent.
    await expect(sweepParkedSlot(0, slot, deps, config())).resolves.not.toThrow();
  });
});

// ---------- supervisor integration: on_stall_detected ----------

describe("supervisor: on_stall_detected", () => {
  it("fires on_stall_detected on first stall detection only", async () => {
    const dispatchFleetHookFn = vi.fn(async (_n: FleetHookName, _c: FleetHookContext) => makeFleetHookResult());
    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });
    io.inspectTree.mockReturnValue([]);
    io.isAlive.mockReturnValue(true);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 55;
    slot.spawnEpoch = NOW - 100;
    // idleTime = 50s > stallThresholdS(30) → flagged, but 50 < stallKillThresholdS(90)
    // so the first poll detects the stall but does NOT reap, keeping slot.stalled=true
    // across both polls and preventing a second on_stall_detected from firing.
    io.workerLivenessVerdict.mockReturnValue({ status: "stalled", laneFresh: false, laneAgeMs: 50_000, crossCheckArmed: true, liveDescendants: false, reason: "lane idle" });

    const cfg = config({ stallThresholdS: 30, stallKillThresholdS: 90 });

    // First poll: should fire on_stall_detected.
    await pollStallDetector(state, deps, cfg);
    const calls1 = dispatchFleetHookFn.mock.calls.filter(([n]) => n === "on_stall_detected");
    expect(calls1).toHaveLength(1);
    expect(calls1[0]![1]).toMatchObject({ event: "on_stall_detected", slot: 0, pid: 55 });

    // Second poll: still stalled but already detected → should NOT fire again.
    await pollStallDetector(state, deps, cfg);
    const calls2 = dispatchFleetHookFn.mock.calls.filter(([n]) => n === "on_stall_detected");
    expect(calls2).toHaveLength(1);
  });
});

// ---------- supervisor integration: on_slot_death ----------

describe("supervisor: on_slot_death", () => {
  it("fires on_slot_death when a dead slot is detected in superviseTick", async () => {
    const dispatchFleetHookFn = vi.fn(async (_n: FleetHookName, _c: FleetHookContext) => makeFleetHookResult());
    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });

    // Slot pid dead → death detected in superviseTick.
    io.isAlive.mockReturnValue(false);
    io.lastExitCode.mockReturnValue(null); // non-clean path

    const state = initSupervisorState(1);
    state.slots[0]!.pid = 88;

    await superviseTick(state, deps, config(), () => false);

    const deathCall = dispatchFleetHookFn.mock.calls.find(([n]) => n === "on_slot_death");
    expect(deathCall).toBeDefined();
    expect(deathCall![1]).toMatchObject({ event: "on_slot_death", slot: 0, pid: 88 });
  });
});

// ---------- supervisor integration: on_slot_spawn / on_respawn ----------

describe("supervisor: on_slot_spawn and on_respawn", () => {
  it("fires on_slot_spawn for each initial slot in runSupervisor", async () => {
    const dispatchFleetHookFn = vi.fn(async (_n: FleetHookName, _c: FleetHookContext) => makeFleetHookResult());
    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });

    io.readyQueueDepth.mockResolvedValue(0);

    const state = initSupervisorState(2);
    // Stop on the first tick (first call returns false so pre_fleet runs, second
    // returns true so superviseTick terminates immediately). The default sleep
    // mock (setTimeout 0) must not be overridden — a Promise.resolve mock would
    // make guardedTick's timeout win the race every time and loop forever.
    let stopped = false;
    const stopReq = () => {
      const s = stopped;
      stopped = true;
      return s;
    };

    await runSupervisor(state, deps, config({ target: 2 }), stopReq);

    const spawnCalls = dispatchFleetHookFn.mock.calls.filter(([n]) => n === "on_slot_spawn");
    // 2 initial slots → 2 on_slot_spawn calls.
    expect(spawnCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("fires on_respawn after a non-clean death respawn", async () => {
    const dispatchFleetHookFn = vi.fn(async (_n: FleetHookName, _c: FleetHookContext) => makeFleetHookResult());
    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });

    // Non-clean exit → handleDeadSlot respawn path.
    io.lastExitCode.mockReturnValue(null);

    const state = initSupervisorState(1);
    const slot = state.slots[0]!;
    slot.pid = 77;

    await handleDeadSlot(0, slot, deps, config(), 1);

    const respawnCalls = dispatchFleetHookFn.mock.calls.filter(([n]) => n === "on_respawn");
    expect(respawnCalls).toHaveLength(1);
  });
});

// ---------- supervisor integration: pre_fleet / post_fleet ----------

describe("supervisor: pre_fleet / post_fleet", () => {
  it("fires pre_fleet before spawning any workers", async () => {
    const spawnOrder: string[] = [];
    const dispatchFleetHookFn = vi.fn(async (name: FleetHookName) => {
      spawnOrder.push(`hook:${name}`);
      return makeFleetHookResult();
    });
    const spawnSlot = vi.fn(async () => {
      spawnOrder.push("spawn");
      return { pid: 42, spawnEpoch: NOW };
    });

    const { deps } = makeDeps({
      dispatchFleetHook: dispatchFleetHookFn,
      spawnSlot,
    });

    const state = initSupervisorState(1);
    // Immediately stop (stop requested before first tick).
    await runSupervisor(state, deps, config(), () => true);

    const preIdx = spawnOrder.indexOf("hook:pre_fleet");
    const spawnIdx = spawnOrder.indexOf("spawn");
    expect(preIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThan(preIdx);
  });

  it("aborts fleet boot when pre_fleet hook returns aborted=true", async () => {
    const dispatchFleetHookFn = vi.fn(async (name: FleetHookName) => {
      if (name === "pre_fleet") return makeFleetHookResult({ aborted: true });
      return makeFleetHookResult();
    });

    const { deps, io } = makeDeps({ dispatchFleetHook: dispatchFleetHookFn });

    const state = initSupervisorState(1);
    await runSupervisor(state, deps, config(), () => false);

    // Aborted: no workers spawned.
    expect(io.spawnSlot).not.toHaveBeenCalled();
  });

  it("fires post_fleet after workers are terminated on stop", async () => {
    const firedHooks: string[] = [];
    const dispatchFleetHookFn = vi.fn(async (name: FleetHookName) => {
      firedHooks.push(name);
      return makeFleetHookResult();
    });
    const killTree = vi.fn(async () => {});

    const { deps } = makeDeps({
      dispatchFleetHook: dispatchFleetHookFn,
      killTree,
    });

    const state = initSupervisorState(1);
    // Stop on the first tick call.
    await runSupervisor(state, deps, config(), () => true);

    expect(firedHooks).toContain("post_fleet");
    // post_fleet fires last (after terminateAll).
    const postIdx = firedHooks.lastIndexOf("post_fleet");
    expect(postIdx).toBeGreaterThanOrEqual(0);
  });

  it("does not fire pre_fleet or post_fleet when dispatchFleetHook is absent", async () => {
    const { deps, io } = makeDeps({ dispatchFleetHook: undefined });
    const state = initSupervisorState(1);
    // Should run without error when hook is absent.
    await expect(
      runSupervisor(state, deps, config(), () => true),
    ).resolves.not.toThrow();
    // Workers still spawn normally.
    expect(io.spawnSlot).toHaveBeenCalled();
  });
});
