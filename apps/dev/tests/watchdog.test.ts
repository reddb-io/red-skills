import { describe, expect, it, vi } from "vitest";
import {
  decideDeadSupervisorRespawn,
  runWatchdog,
  teardownWedgedSupervisor,
  type DeadSupervisorSignals,
  type WatchdogIO,
} from "../src/core/watchdog.js";
import type { SupervisorLiveness } from "../src/core/supervisor.js";

const NOW = 1700000000;
const STALE = 300;
const PROGRESS_STALE = 900;

interface FakeIo {
  now: ReturnType<typeof vi.fn>;
  liveness: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  killWorkers: ReturnType<typeof vi.fn>;
  clearControlFiles: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
  deadSupervisorSignals: ReturnType<typeof vi.fn>;
  readRestartLedger: ReturnType<typeof vi.fn>;
  writeRestartLedger: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function makeLiveness(over: Partial<SupervisorLiveness> = {}): SupervisorLiveness {
  return {
    pid: null,
    pidAlive: false,
    lastHeartbeatEpoch: null,
    lastProgressEpoch: null,
    slotsBusy: 0,
    ...over,
  };
}

function makeSignals(over: Partial<DeadSupervisorSignals> = {}): DeadSupervisorSignals {
  return { readyForAgent: 0, target: 2, liveWorkers: 0, stopRequested: false, ...over };
}

function makeIo(
  liveness: SupervisorLiveness,
  signals: DeadSupervisorSignals = makeSignals(),
  ledger: number[] = [],
): { io: WatchdogIO; fake: FakeIo } {
  const fake: FakeIo = {
    now: vi.fn(() => NOW),
    liveness: vi.fn(async () => liveness),
    killTree: vi.fn(async () => {}),
    killWorkers: vi.fn(async () => {}),
    clearControlFiles: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
    deadSupervisorSignals: vi.fn(async () => signals),
    readRestartLedger: vi.fn(async () => ledger),
    writeRestartLedger: vi.fn(async () => {}),
    log: vi.fn(),
  };
  return { io: fake as unknown as WatchdogIO, fake };
}

describe("runWatchdog — quiescent supervisor recovery (#407)", () => {
  it("recovers a wedged supervisor: kill → killWorkers → clear → reconcile → relaunch, exactly once", async () => {
    const { io, fake } = makeIo(
      makeLiveness({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 }),
    );

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.recovered).toBe(true);
    expect(result.health).toBe("quiescent");
    expect(result.pid).toBe(4242);
    expect(result.staleForS).toBe(9999);

    // The full recovery sequence fired exactly once.
    expect(fake.killTree).toHaveBeenCalledTimes(1);
    expect(fake.killTree).toHaveBeenCalledWith(4242);
    expect(fake.killWorkers).toHaveBeenCalledTimes(1);
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);

    // Ordering: kill → killWorkers → clear → reconcile → relaunch.
    const order = [
      fake.killTree.mock.invocationCallOrder[0]!,
      fake.killWorkers.mock.invocationCallOrder[0]!,
      fake.clearControlFiles.mock.invocationCallOrder[0]!,
      fake.reconcile.mock.invocationCallOrder[0]!,
      fake.relaunch.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leaves a healthy supervisor untouched (no kill, no relaunch)", async () => {
    const { io, fake } = makeIo(
      makeLiveness({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 10 }),
    );

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.health).toBe("healthy");
    expect(result.recovered).toBe(false);
    expect(fake.killTree).not.toHaveBeenCalled();
    expect(fake.killWorkers).not.toHaveBeenCalled();
    expect(fake.clearControlFiles).not.toHaveBeenCalled();
    expect(fake.reconcile).not.toHaveBeenCalled();
    expect(fake.relaunch).not.toHaveBeenCalled();
  });

  it("does nothing when no supervisor is alive (absent)", async () => {
    const { io, fake } = makeIo(makeLiveness());

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.health).toBe("absent");
    expect(result.recovered).toBe(false);
    expect(fake.relaunch).not.toHaveBeenCalled();
  });

  it("does not double-fire once the relaunched fleet reports a fresh heartbeat", async () => {
    // First pass: wedged. Second pass: the relaunch stamped a fresh heartbeat,
    // so classify sees healthy and recovery does NOT fire again.
    const wedged = makeLiveness({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 });
    const fresh = makeLiveness({ pid: 5555, pidAlive: true, lastHeartbeatEpoch: NOW - 1 });
    const { io, fake } = makeIo(wedged);
    fake.liveness.mockResolvedValueOnce(wedged).mockResolvedValueOnce(fresh);

    const first = await runWatchdog(io, STALE, PROGRESS_STALE);
    const second = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(first.recovered).toBe(true);
    expect(second.recovered).toBe(false);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);
  });

  it("recovers even if relaunch throws (logged, never rejects)", async () => {
    const { io, fake } = makeIo(
      makeLiveness({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 }),
    );
    fake.relaunch.mockRejectedValueOnce(new Error("spawn failed"));

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.recovered).toBe(true);
    expect(fake.killTree).toHaveBeenCalledTimes(1);
    expect(fake.log).toHaveBeenCalledWith(expect.stringContaining("relaunch failed"));
  });

  it("recovers a supervisor whose heartbeat is fresh but progress epoch is stale with busy slots (#579)", async () => {
    // Fresh heartbeat (loop is alive) but no completed tick for 1000s with 2 busy slots.
    const { io, fake } = makeIo(
      makeLiveness({
        pid: 7777,
        pidAlive: true,
        lastHeartbeatEpoch: NOW - 10, // fresh — loop is ticking
        lastProgressEpoch: NOW - 1000, // stale — every tick has been abandoned
        slotsBusy: 2,
      }),
    );

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.recovered).toBe(true);
    expect(result.health).toBe("quiescent");
    expect(fake.killTree).toHaveBeenCalledTimes(1);
    expect(fake.killWorkers).toHaveBeenCalledTimes(1);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);
  });

  it("does not recover when fresh heartbeat + stale progress but no busy slots (idle fleet)", async () => {
    // Fresh heartbeat + stale progress epoch, but slotsBusy === 0 → idle, not stuck.
    const { io, fake } = makeIo(
      makeLiveness({
        pid: 7777,
        pidAlive: true,
        lastHeartbeatEpoch: NOW - 10,
        lastProgressEpoch: NOW - 1000,
        slotsBusy: 0,
      }),
    );

    const result = await runWatchdog(io, STALE, PROGRESS_STALE);

    expect(result.health).toBe("healthy");
    expect(result.recovered).toBe(false);
    expect(fake.killTree).not.toHaveBeenCalled();
  });
});

describe("decideDeadSupervisorRespawn — pure crash-loop-bounded respawn decision (#1097)", () => {
  const base = { now: NOW, windowS: 300, maxRestarts: 3 };

  it("respawns a dead supervisor with stranded work and workers below target", () => {
    const d = decideDeadSupervisorRespawn({
      ...base,
      readyForAgent: 4,
      liveWorkers: 1,
      target: 2,
      priorRestarts: [],
    });
    expect(d.action).toBe("respawn");
    expect(d.restarts).toEqual([NOW]);
    expect(d.countInWindow).toBe(1);
  });

  it("skips when the queue is empty (a supervisor that cleanly drained is not a fault)", () => {
    const d = decideDeadSupervisorRespawn({
      ...base,
      readyForAgent: 0,
      liveWorkers: 0,
      target: 2,
      priorRestarts: [],
    });
    expect(d.action).toBe("skip");
  });

  it("skips when live workers already meet target (not short-handed)", () => {
    const d = decideDeadSupervisorRespawn({
      ...base,
      readyForAgent: 5,
      liveWorkers: 2,
      target: 2,
      priorRestarts: [],
    });
    expect(d.action).toBe("skip");
  });

  it("prunes restart epochs older than the window before counting", () => {
    // Two ancient restarts (outside window) + one recent → count is 1, well under cap.
    const d = decideDeadSupervisorRespawn({
      ...base,
      readyForAgent: 3,
      liveWorkers: 0,
      target: 2,
      priorRestarts: [NOW - 1000, NOW - 900, NOW - 10],
    });
    expect(d.action).toBe("respawn");
    // Ancient two pruned; kept the recent one + this respawn.
    expect(d.restarts).toEqual([NOW - 10, NOW]);
    expect(d.countInWindow).toBe(2);
  });

  it("suppresses (crash-loop) once the pruned restart count reaches maxRestarts", () => {
    const d = decideDeadSupervisorRespawn({
      ...base,
      readyForAgent: 3,
      liveWorkers: 0,
      target: 2,
      priorRestarts: [NOW - 30, NOW - 20, NOW - 10], // 3 == maxRestarts
    });
    expect(d.action).toBe("crash-loop-suppressed");
    expect(d.countInWindow).toBe(3);
    // The ledger is not extended on suppression.
    expect(d.restarts).toEqual([NOW - 30, NOW - 20, NOW - 10]);
  });
});

describe("runWatchdog — dead-supervisor safety net (#1097)", () => {
  const BOUND = { maxRestarts: 3, windowS: 300 };
  const deadPid = makeLiveness({ pid: 4242, pidAlive: false });

  it("respawns a dead supervisor: records restart, clears files, reconciles, relaunches", async () => {
    const { io, fake } = makeIo(deadPid, makeSignals({ readyForAgent: 3, liveWorkers: 0, target: 2 }));

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.health).toBe("absent");
    expect(result.respawnedDeadSupervisor).toBe(true);
    expect(result.crashLoopSuppressed).toBe(false);
    expect(result.recovered).toBe(false); // that flag is the quiescent (#407) path

    expect(fake.writeRestartLedger).toHaveBeenCalledWith([NOW]);
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);
    // The dead-supervisor path must NOT kill the surviving detached workers.
    expect(fake.killWorkers).not.toHaveBeenCalled();
    expect(fake.killTree).not.toHaveBeenCalled();
  });

  it("does NOT resurrect a gracefully stopped fleet (pid file gone → pid null)", async () => {
    const { io, fake } = makeIo(makeLiveness({ pid: null }), makeSignals({ readyForAgent: 9, liveWorkers: 0 }));

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.health).toBe("absent");
    expect(result.respawnedDeadSupervisor).toBe(false);
    expect(fake.deadSupervisorSignals).not.toHaveBeenCalled();
    expect(fake.relaunch).not.toHaveBeenCalled();
  });

  it("does NOT resurrect when a graceful stop was requested (stop file present)", async () => {
    const { io, fake } = makeIo(
      deadPid,
      makeSignals({ readyForAgent: 5, liveWorkers: 0, target: 2, stopRequested: true }),
    );

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.respawnedDeadSupervisor).toBe(false);
    expect(fake.relaunch).not.toHaveBeenCalled();
    expect(fake.writeRestartLedger).not.toHaveBeenCalled();
  });

  it("skips a dead supervisor whose queue is empty", async () => {
    const { io, fake } = makeIo(deadPid, makeSignals({ readyForAgent: 0, liveWorkers: 0, target: 2 }));

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.respawnedDeadSupervisor).toBe(false);
    expect(fake.relaunch).not.toHaveBeenCalled();
  });

  it("suppresses respawn and emits a loud alert once the crash-loop bound is hit", async () => {
    const { io, fake } = makeIo(
      deadPid,
      makeSignals({ readyForAgent: 3, liveWorkers: 0, target: 2 }),
      [NOW - 30, NOW - 20, NOW - 10], // 3 == maxRestarts
    );

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.crashLoopSuppressed).toBe(true);
    expect(result.respawnedDeadSupervisor).toBe(false);
    expect(fake.relaunch).not.toHaveBeenCalled();
    expect(fake.writeRestartLedger).not.toHaveBeenCalled();
    expect(fake.log).toHaveBeenCalledWith(expect.stringContaining("max-restarts cap"));
  });

  it("still records the respawn + relaunches even when relaunch throws (logged)", async () => {
    const { io, fake } = makeIo(deadPid, makeSignals({ readyForAgent: 3, liveWorkers: 0, target: 2 }));
    fake.relaunch.mockRejectedValueOnce(new Error("spawn failed"));

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.respawnedDeadSupervisor).toBe(true);
    expect(fake.writeRestartLedger).toHaveBeenCalledWith([NOW]);
    expect(fake.log).toHaveBeenCalledWith(expect.stringContaining("relaunch failed"));
  });

  it("is inert when the IO exposes no dead-supervisor signal source (back-compat)", async () => {
    const { io, fake } = makeIo(deadPid, makeSignals({ readyForAgent: 3, liveWorkers: 0, target: 2 }));
    // A pre-#1097 IO surface: drop the new closure entirely.
    delete (io as { deadSupervisorSignals?: unknown }).deadSupervisorSignals;

    const result = await runWatchdog(io, STALE, PROGRESS_STALE, BOUND);

    expect(result.respawnedDeadSupervisor).toBe(false);
    expect(fake.relaunch).not.toHaveBeenCalled();
  });
});

describe("teardownWedgedSupervisor", () => {
  it("kills, killWorkers, clears, and reconciles best-effort even when a step throws", async () => {
    const { io, fake } = makeIo(
      makeLiveness({ pid: 7, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 }),
    );
    fake.killTree.mockRejectedValueOnce(new Error("already gone"));

    await expect(teardownWedgedSupervisor(io, 7)).resolves.toBeUndefined();
    expect(fake.killWorkers).toHaveBeenCalledTimes(1);
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
  });

  it("skips killTree when there is no pid but still kills workers", async () => {
    const { io, fake } = makeIo(makeLiveness());
    await teardownWedgedSupervisor(io, null);
    expect(fake.killTree).not.toHaveBeenCalled();
    expect(fake.killWorkers).toHaveBeenCalledTimes(1);
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
  });

  it("continues recovery when killWorkers throws", async () => {
    const { io, fake } = makeIo(
      makeLiveness({ pid: 7, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 }),
    );
    fake.killWorkers.mockRejectedValueOnce(new Error("workers failed"));

    await expect(teardownWedgedSupervisor(io, 7)).resolves.toBeUndefined();
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
  });
});
