import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEnginePaths,
  createSingletonEventLane,
  createSingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createResidentCron,
  createResidentJanitor,
  type ResidentCronFs,
  type ResidentCronTimers,
} from "../src/resident-cron.js";

function memoryFs(): ResidentCronFs {
  const files = new Map<string, string>();
  return {
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async (path) => {
      const value = files.get(path);
      if (value !== undefined) return value;
      throw Object.assign(new Error(`missing ${path}`), { code: "ENOENT" });
    }),
    writeFile: vi.fn(async (path, value) => {
      files.set(path, value);
    }),
    rename: vi.fn(async (from, to) => {
      const value = files.get(from);
      if (value === undefined) {
        throw Object.assign(new Error(`missing ${from}`), { code: "ENOENT" });
      }
      files.set(to, value);
      files.delete(from);
    }),
  };
}

const idleTimers: ResidentCronTimers = {
  setInterval: vi.fn(() => 1),
  clearInterval: vi.fn(),
};

describe("resident repo cron", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) => rm(root, { recursive: true, force: true })),
    );
    roots.length = 0;
  });

  it("round-trips its schedule and catches up one missed window on the next boot", async () => {
    const fs = memoryFs();
    let now = new Date("2026-07-23T00:00:00.000Z");
    const firedAt: string[] = [];
    const options = {
      root: "/repo",
      name: "janitor",
      intervalMs: 60_000,
      fs,
      timers: idleTimers,
      clock: () => now,
      run: async () => {
        firedAt.push(now.toISOString());
      },
    };

    const firstBoot = createResidentCron(options);
    await firstBoot.start();
    await firstBoot.stop();
    expect(firstBoot.schedule()).toEqual({
      last_fired_at: "2026-07-23T00:00:00.000Z",
      next_due_at: "2026-07-23T00:01:00.000Z",
      interval_ms: 60_000,
    });

    now = new Date("2026-07-23T00:03:20.000Z");
    const nextBoot = createResidentCron(options);
    await nextBoot.start();
    await nextBoot.stop();

    expect(firedAt).toEqual([
      "2026-07-23T00:00:00.000Z",
      "2026-07-23T00:03:20.000Z",
    ]);
    expect(nextBoot.schedule()).toEqual({
      last_fired_at: "2026-07-23T00:03:20.000Z",
      next_due_at: "2026-07-23T00:04:00.000Z",
      interval_ms: 60_000,
    });
  });

  it("runs the shared hygiene sweep only under the janitor lease and records cron activity", async () => {
    const root = await mkdtemp(join(tmpdir(), "resident-janitor-"));
    roots.push(root);
    await mkdir(join(root, ".red"));
    const paths = createEnginePaths(join(root, ".red"));
    const leases = createSingletonLeaseStore(paths, {
      clock: () => "2026-07-23T01:00:00.000Z",
      isPidAlive: () => true,
    });
    const lane = createSingletonEventLane(paths, {
      clock: () => "2026-07-23T01:00:00.000Z",
    });
    const sharedBootSweep = vi.fn(async () => undefined);
    const losingSweep = vi.fn(async () => undefined);
    const first = createResidentJanitor({
      root,
      owner: { pid: 4100, startTime: "first" },
      leases,
      lane,
      clock: () => new Date("2026-07-23T01:00:00.000Z"),
      timers: idleTimers,
      sweep: sharedBootSweep,
    });
    const second = createResidentJanitor({
      root,
      owner: { pid: 4200, startTime: "second" },
      leases,
      lane,
      clock: () => new Date("2026-07-23T01:00:00.000Z"),
      timers: idleTimers,
      sweep: losingSweep,
    });

    expect(await first.start()).toMatchObject({ acquired: true });
    expect(await second.start()).toMatchObject({ acquired: false });
    expect(sharedBootSweep).toHaveBeenCalledTimes(1);
    expect(losingSweep).not.toHaveBeenCalled();
    await first.stop();
    await second.stop();
    expect(
      (await lane.read()).map((event) => ({
        singleton: event.singleton,
        kind: event.kind,
        status: event.payload?.status,
      })),
    ).toEqual([
      { singleton: "janitor", kind: "janitor.sweep", status: "passed" },
      { singleton: "janitor", kind: "resident.cron", status: "passed" },
    ]);

    expect(await leases.read("janitor")).toBeUndefined();
  });
});
