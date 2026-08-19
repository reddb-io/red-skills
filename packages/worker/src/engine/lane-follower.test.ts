import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CastleLaneRecord } from "./contracts/index.js";
import {
  castleLanePath,
  createCastleLaneWriters,
  readCastleLaneRecords,
} from "./lane-writers.js";
import {
  createLaneFollower,
  listCastleLaneFiles,
  type LaneEvent,
} from "./lane-follower.js";
import { createEnginePaths, type EnginePaths } from "./paths.js";

describe("castle lane follower", () => {
  let dir: string;
  let paths: EnginePaths;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "lane-follower-"));
    paths = createEnginePaths(join(dir, ".red"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("delivers records appended after subscription, not pre-existing ones", async () => {
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T00:00:00.000Z",
    });
    // A record that exists BEFORE anyone subscribes.
    await writers.worker("w1").append({
      kind: "worker.claimed",
      worker_id: "w1",
      issue: 100,
    });

    const follower = createLaneFollower({
      list: () => listCastleLaneFiles(paths, ["worker"]),
    });
    const events: LaneEvent[] = [];
    const unsubscribe = await follower.subscribe((event) => {
      events.push(event);
    });

    // A synthetic lane append AFTER subscription drives an event.
    await writers.worker("w1").append({
      kind: "worker.completed",
      worker_id: "w1",
      issue: 100,
    });
    const delivered = await follower.poll();
    unsubscribe();

    expect(delivered).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.record.kind).toBe("worker.completed");
    // The pre-existing worker.claimed record is never delivered.
    expect(events.some((e) => e.record.kind === "worker.claimed")).toBe(false);
  });

  it("delivers records byte-compatible with the logs tool record shape", async () => {
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T01:02:03.000Z",
    });
    const follower = createLaneFollower({
      list: () => listCastleLaneFiles(paths, ["worker", "supervisor"]),
    });
    const events: LaneEvent[] = [];
    await follower.subscribe((event) => events.push(event));

    await writers.supervisor("s1").append({
      kind: "supervisor.retired",
      supervisor_id: "s1",
      payload: { reason: "halt", slots: 3 },
    });
    await follower.poll();

    const lanePath = castleLanePath(paths, "supervisor", "s1");
    const [logsRecord] = await readCastleLaneRecords(lanePath);
    // The pushed event record equals the record the logs tool would return.
    expect(events[0]!.record).toEqual(logsRecord as CastleLaneRecord);
    expect(events[0]!.path).toBe(lanePath);
  });

  it("discovers lane files appended after subscription (new workers)", async () => {
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T02:00:00.000Z",
    });
    const follower = createLaneFollower({
      list: () => listCastleLaneFiles(paths, ["worker"]),
    });
    const events: LaneEvent[] = [];
    await follower.subscribe((event) => events.push(event));

    // A worker that did not exist at subscription time appears later.
    await writers.worker("late").append({
      kind: "worker.blocked",
      worker_id: "late",
      issue: 7,
    });
    await follower.poll();

    expect(events).toHaveLength(1);
    expect(events[0]!.record.worker_id).toBe("late");
  });

  it("introduces no write path: following never mutates lane files", async () => {
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T03:00:00.000Z",
    });
    await writers.worker("w1").append({
      kind: "worker.claimed",
      worker_id: "w1",
      issue: 1,
    });
    const lanePath = castleLanePath(paths, "worker", "w1");
    const before = await readFile(lanePath, "utf8");

    const follower = createLaneFollower({
      list: () => listCastleLaneFiles(paths, ["worker"]),
    });
    await follower.subscribe(() => {});
    await follower.poll();
    await follower.poll();

    const after = await readFile(lanePath, "utf8");
    expect(after).toBe(before);
  });

  it("stops delivering to unsubscribed listeners", async () => {
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-23T04:00:00.000Z",
    });
    const follower = createLaneFollower({
      list: () => listCastleLaneFiles(paths, ["worker"]),
    });
    const events: LaneEvent[] = [];
    const unsubscribe = await follower.subscribe((e) => events.push(e));
    unsubscribe();

    await writers.worker("w1").append({
      kind: "worker.completed",
      worker_id: "w1",
      issue: 1,
    });
    await follower.poll();

    expect(events).toHaveLength(0);
  });
});
