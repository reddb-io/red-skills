import { describe, expect, it, vi } from "vitest";
import { runWatchdog, teardownWedgedSupervisor, type WatchdogIO } from "../src/core/watchdog.js";
import type { SupervisorLiveness } from "../src/core/supervisor.js";

const NOW = 1700000000;
const STALE = 300;

interface FakeIo {
  now: ReturnType<typeof vi.fn>;
  liveness: ReturnType<typeof vi.fn>;
  killTree: ReturnType<typeof vi.fn>;
  clearControlFiles: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  relaunch: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
}

function makeIo(liveness: SupervisorLiveness): { io: WatchdogIO; fake: FakeIo } {
  const fake: FakeIo = {
    now: vi.fn(() => NOW),
    liveness: vi.fn(async () => liveness),
    killTree: vi.fn(async () => {}),
    clearControlFiles: vi.fn(async () => {}),
    reconcile: vi.fn(async () => {}),
    relaunch: vi.fn(async () => {}),
    log: vi.fn(),
  };
  return { io: fake as unknown as WatchdogIO, fake };
}

describe("runWatchdog — quiescent supervisor recovery (#407)", () => {
  it("recovers a wedged supervisor: kill → clear → reconcile → relaunch, exactly once", async () => {
    const { io, fake } = makeIo({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 });

    const result = await runWatchdog(io, STALE);

    expect(result.recovered).toBe(true);
    expect(result.health).toBe("quiescent");
    expect(result.pid).toBe(4242);
    expect(result.staleForS).toBe(9999);

    // The full recovery sequence fired exactly once.
    expect(fake.killTree).toHaveBeenCalledTimes(1);
    expect(fake.killTree).toHaveBeenCalledWith(4242);
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);

    // Ordering: kill before clear before reconcile before relaunch.
    const order = [
      fake.killTree.mock.invocationCallOrder[0]!,
      fake.clearControlFiles.mock.invocationCallOrder[0]!,
      fake.reconcile.mock.invocationCallOrder[0]!,
      fake.relaunch.mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leaves a healthy supervisor untouched (no kill, no relaunch)", async () => {
    const { io, fake } = makeIo({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 10 });

    const result = await runWatchdog(io, STALE);

    expect(result.health).toBe("healthy");
    expect(result.recovered).toBe(false);
    expect(fake.killTree).not.toHaveBeenCalled();
    expect(fake.clearControlFiles).not.toHaveBeenCalled();
    expect(fake.reconcile).not.toHaveBeenCalled();
    expect(fake.relaunch).not.toHaveBeenCalled();
  });

  it("does nothing when no supervisor is alive (absent)", async () => {
    const { io, fake } = makeIo({ pid: null, pidAlive: false, lastHeartbeatEpoch: null });

    const result = await runWatchdog(io, STALE);

    expect(result.health).toBe("absent");
    expect(result.recovered).toBe(false);
    expect(fake.relaunch).not.toHaveBeenCalled();
  });

  it("does not double-fire once the relaunched fleet reports a fresh heartbeat", async () => {
    // First pass: wedged. Second pass: the relaunch stamped a fresh heartbeat,
    // so classify sees healthy and recovery does NOT fire again.
    const wedged: SupervisorLiveness = { pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 };
    const fresh: SupervisorLiveness = { pid: 5555, pidAlive: true, lastHeartbeatEpoch: NOW - 1 };
    const { io, fake } = makeIo(wedged);
    fake.liveness.mockResolvedValueOnce(wedged).mockResolvedValueOnce(fresh);

    const first = await runWatchdog(io, STALE);
    const second = await runWatchdog(io, STALE);

    expect(first.recovered).toBe(true);
    expect(second.recovered).toBe(false);
    expect(fake.relaunch).toHaveBeenCalledTimes(1);
  });

  it("recovers even if relaunch throws (logged, never rejects)", async () => {
    const { io, fake } = makeIo({ pid: 4242, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 });
    fake.relaunch.mockRejectedValueOnce(new Error("spawn failed"));

    const result = await runWatchdog(io, STALE);

    expect(result.recovered).toBe(true);
    expect(fake.killTree).toHaveBeenCalledTimes(1);
    expect(fake.log).toHaveBeenCalledWith(expect.stringContaining("relaunch failed"));
  });
});

describe("teardownWedgedSupervisor", () => {
  it("kills, clears, and reconciles best-effort even when a step throws", async () => {
    const { io, fake } = makeIo({ pid: 7, pidAlive: true, lastHeartbeatEpoch: NOW - 9999 });
    fake.killTree.mockRejectedValueOnce(new Error("already gone"));

    await expect(teardownWedgedSupervisor(io, 7)).resolves.toBeUndefined();
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
  });

  it("skips killTree when there is no pid", async () => {
    const { io, fake } = makeIo({ pid: null, pidAlive: false, lastHeartbeatEpoch: null });
    await teardownWedgedSupervisor(io, null);
    expect(fake.killTree).not.toHaveBeenCalled();
    expect(fake.clearControlFiles).toHaveBeenCalledTimes(1);
  });
});
