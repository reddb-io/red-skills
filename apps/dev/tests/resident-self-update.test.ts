import { describe, expect, it, vi } from "vitest";
import type {
  SingletonLease,
  SingletonLeaseAcquireResult,
  SingletonLeaseOwner,
  SingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import {
  RESIDENT_SELF_UPDATE_INTERVAL_MS,
  SELF_UPDATE_SINGLETON,
  startResidentSelfUpdate,
  type ResidentSelfUpdateTimers,
} from "../src/resident-self-update.js";

const LEASE: SingletonLease = {
  pid: 4242,
  start_time: "start",
  acquired_at: "2026-08-03T00:00:00.000Z",
  renewed_at: "2026-08-03T00:00:00.000Z",
};

function leaseStore(
  acquire: SingletonLeaseAcquireResult = { acquired: true, reaped: false, lease: LEASE },
): SingletonLeaseStore & { released: string[] } {
  const released: string[] = [];
  return {
    released,
    read: async () => LEASE,
    acquire: async () => acquire,
    renew: async () => LEASE,
    release: async (name: string, _owner: SingletonLeaseOwner) => {
      released.push(name);
      return true;
    },
  };
}

function manualTimers(): ResidentSelfUpdateTimers & { fire(): void; cleared: number } {
  const state = {
    callback: undefined as (() => void) | undefined,
    cleared: 0,
    fire() {
      state.callback?.();
    },
    setInterval(callback: () => void) {
      state.callback = callback;
      return "timer";
    },
    clearInterval() {
      state.cleared += 1;
    },
  };
  return state as ResidentSelfUpdateTimers & { fire(): void; cleared: number };
}

describe("resident self-update belt (#3178)", () => {
  it("checks at resident start and again on every interval", async () => {
    const update = vi.fn(async () => ({ status: "up-to-date" as const, version: "3.3.19" }));
    const timers = manualTimers();
    const belt = await startResidentSelfUpdate({
      root: process.cwd(),
      installedVersion: "3.3.19",
      cacheDir: "/cache/bundles",
      channel: "stable",
      update,
      leases: leaseStore(),
      owner: { pid: 4242, startTime: "start" },
      timers,
      intervalMs: RESIDENT_SELF_UPDATE_INTERVAL_MS,
    });

    expect(belt).not.toBeNull();
    await belt!.check();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({
      plugin: "dev",
      installedVersion: "3.3.19",
      cacheDir: "/cache/bundles",
      channel: "stable",
    }));

    timers.fire();
    await belt!.check();
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("keeps checking after a failed update and releases its singleton on stop", async () => {
    let calls = 0;
    const update = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("registry unavailable");
      return { status: "up-to-date" as const, version: "3.3.19" };
    });
    const notices: string[] = [];
    const timers = manualTimers();
    const leases = leaseStore();
    const belt = await startResidentSelfUpdate({
      installedVersion: "3.3.19",
      update,
      leases,
      owner: { pid: 4242, startTime: "start" },
      timers,
      notice: (line) => notices.push(line),
    });

    await belt!.check();
    expect(notices[0]).toContain("registry unavailable");
    await belt!.check();
    expect(update).toHaveBeenCalledTimes(2);

    await belt!.stop();
    expect(timers.cleared).toBe(1);
    expect(leases.released).toEqual([SELF_UPDATE_SINGLETON]);
  });
});
