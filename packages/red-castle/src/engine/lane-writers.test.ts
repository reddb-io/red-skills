import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, parseRecords } from "@reddb-io/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CastleLaneValidationError,
  appendCastleHistoryRecord,
  appendCastleLaneRecord,
  castleLanePath,
  castleStateSnapshotPath,
  createCastleLaneWriters,
  readCastleLaneRecords,
  writeCastleStateSnapshot,
} from "./lane-writers.js";
import { createEnginePaths } from "./paths.js";

describe("castle lane writers", () => {
  let redRoot: string;

  beforeEach(() => {
    redRoot = join(
      tmpdir(),
      `castle-lane-writers-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ".red",
    );
  });

  afterEach(async () => {
    await rm(redRoot, { recursive: true, force: true });
  });

  it("covers worker, supervisor, monitor, and liveness lanes with .toonl files", async () => {
    const paths = createEnginePaths(redRoot);
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-16T20:00:00.000Z",
    });

    await writers.worker("wAB12").append({
      kind: "worker.claimed",
      worker_id: "wAB12",
      issue: 1905,
      attempt: 1,
      msg: "claimed issue 1905",
      payload: { runner: "codex" },
    });
    await writers.supervisor("s1").append({
      kind: "supervisor.scaled",
      supervisor_id: "s1",
      payload: { desired_workers: 2 },
    });
    await writers.monitor("m1").append({
      kind: "supervisor.retired",
      supervisor_id: "s1",
      payload: { reason: "idle" },
    });
    await writers.liveness("wAB12").append({
      kind: "worker.heartbeat",
      worker_id: "wAB12",
      payload: { signal: "iteration-start" },
    });

    expect(castleLanePath(paths, "worker", "wAB12")).toBe(
      join(redRoot, "tmp", "workers", "wAB12", "worker.log.toonl"),
    );
    expect(castleLanePath(paths, "supervisor", "s1")).toBe(
      join(redRoot, "tmp", "supervisors", "s1", "supervisor.log.toonl"),
    );
    expect(castleLanePath(paths, "monitor", "m1")).toBe(
      join(redRoot, "tmp", "monitors", "m1", "monitor.log.toonl"),
    );
    expect(castleLanePath(paths, "liveness", "wAB12")).toBe(
      join(redRoot, "tmp", "workers", "wAB12", "liveness.toonl"),
    );

    for (const path of [
      castleLanePath(paths, "worker", "wAB12"),
      castleLanePath(paths, "supervisor", "s1"),
      castleLanePath(paths, "monitor", "m1"),
      castleLanePath(paths, "liveness", "wAB12"),
    ]) {
      const raw = await readFile(path, "utf8");
      expect(raw.trimStart().startsWith("{")).toBe(false);
      expect(parseRecords(raw)).toHaveLength(1);
    }

    expect(
      await readCastleLaneRecords(castleLanePath(paths, "worker", "wAB12")),
    ).toEqual([
      {
        at: "2026-07-16T20:00:00.000Z",
        kind: "worker.claimed",
        worker_id: "wAB12",
        issue: 1905,
        attempt: 1,
        msg: "claimed issue 1905",
        payload: { runner: "codex" },
      },
    ]);
  });

  it("caps liveness on append with a tiny ceiling and keeps the newest beat", async () => {
    const paths = createEnginePaths(redRoot);
    const maxBytes = 420;
    const writers = createCastleLaneWriters(paths, {
      clock: () => "2026-07-16T20:00:00.000Z",
      livenessMaxBytes: maxBytes,
    });
    const writer = writers.liveness("wAB12");

    for (let beat = 1; beat <= 12; beat += 1) {
      await writer.append({
        kind: "worker.heartbeat",
        worker_id: "wAB12",
        payload: { signal: `beat-${beat}` },
      });
    }

    expect((await stat(writer.path)).size).toBeLessThanOrEqual(maxBytes);
    const records = await readCastleLaneRecords(writer.path);
    expect(records.length).toBeLessThan(12);
    expect(records.at(-1)?.payload).toEqual({ signal: "beat-12" });
  });

  it("trims a maxLines-only lane on append and keeps the newest records", async () => {
    const paths = createEnginePaths(redRoot);
    const path = castleLanePath(paths, "monitor", "m1");

    for (let record = 1; record <= 4; record += 1) {
      await appendCastleLaneRecord(
        path,
        {
          at: `2026-07-16T20:00:0${record}.000Z`,
          kind: "monitor.sampled",
          msg: `record-${record}`,
        },
        { retentionPolicy: { maxLines: 3, targetRatio: 0.5 } },
      );
    }

    expect(
      (await readCastleLaneRecords(path)).map((record) => record.msg),
    ).toEqual(["record-3", "record-4"]);
  });

  it("enforces retention through worker, supervisor, and monitor writers", async () => {
    const writers = createCastleLaneWriters(createEnginePaths(redRoot), {
      clock: () => "2026-07-16T20:00:00.000Z",
      retentionPolicies: {
        worker: { maxLines: 3, targetRatio: 0.5 },
        supervisor: { maxLines: 3, targetRatio: 0.5 },
        monitor: { maxLines: 3, targetRatio: 0.5 },
      },
    });

    for (const writer of [
      writers.worker("wAB12"),
      writers.supervisor("s1"),
      writers.monitor("m1"),
    ]) {
      for (let record = 1; record <= 4; record += 1) {
        await writer.append({
          kind: "lane.sampled",
          msg: `record-${record}`,
        });
      }
      expect(
        (await readCastleLaneRecords(writer.path)).map((record) => record.msg),
      ).toEqual(["record-3", "record-4"]);
    }
  });

  it("writes worker and supervisor state snapshots as TOON state.toon documents", async () => {
    const paths = createEnginePaths(redRoot);
    const workerSnapshot = {
      kind: "worker" as const,
      id: "wAB12",
      version: 1,
      updated_at: "2026-07-16T20:01:00.000Z",
      worker_id: "wAB12",
      runner: "codex",
      pid: 123,
      current: { issue: 1905 },
      queue: [1905],
      completed: [],
      envelope: { posted: false },
    };

    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "worker", "wAB12"),
      workerSnapshot,
    );
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(paths, "supervisor", "s1"),
      {
        kind: "supervisor",
        id: "s1",
        version: 1,
        updated_at: "2026-07-16T20:02:00.000Z",
        supervisor_id: "s1",
        queue: [1905, 1906],
        completed: [1904],
      },
    );

    const workerRaw = await readFile(
      castleStateSnapshotPath(paths, "worker", "wAB12"),
      "utf8",
    );
    expect(workerRaw.trimStart().startsWith("{")).toBe(false);
    expect(decode(workerRaw)).toEqual(workerSnapshot);
    expect(existsSync(castleStateSnapshotPath(paths, "supervisor", "s1"))).toBe(
      true,
    );
  });

  it("appends durable castle history records as TOONL under state/castle", async () => {
    const paths = createEnginePaths(redRoot);

    await appendCastleHistoryRecord(paths.castleHistory, {
      ts: "2026-07-16T20:03:00.000Z",
      epoch: 1784232180,
      worker: "wAB12",
      issue: 1905,
      event: "done",
      duration_s: 12,
      runner: "codex",
      merge_sha: "abc123",
    });

    const raw = await readFile(paths.castleHistory, "utf8");
    expect(raw.trimStart().startsWith("{")).toBe(false);
    expect(parseRecords(raw)).toEqual([
      {
        ts: "2026-07-16T20:03:00.000Z",
        epoch: 1784232180,
        worker: "wAB12",
        issue: 1905,
        event: "done",
        duration_s: 12,
        runner: "codex",
        merge_sha: "abc123",
      },
    ]);
  });

  it("enforces the castle-history policy at its append site", async () => {
    const paths = createEnginePaths(redRoot);

    for (let record = 1; record <= 4; record += 1) {
      await appendCastleHistoryRecord(
        paths.castleHistory,
        {
          ts: `2026-07-16T20:03:0${record}.000Z`,
          epoch: 1784232180 + record,
          worker: `wAB1${record}`,
          issue: 1905,
          event: "done",
          duration_s: record,
          runner: "codex",
        },
        { retentionPolicy: { maxLines: 3, targetRatio: 0.5 } },
      );
    }

    expect(
      parseRecords(await readFile(paths.castleHistory, "utf8")).map(
        (row) => row.worker,
      ),
    ).toEqual(["wAB13", "wAB14"]);
  });

  it("rejects records outside the published red.castle.lane.v1 family before writing", async () => {
    const paths = createEnginePaths(redRoot);
    const path = castleLanePath(paths, "worker", "wAB12");

    await expect(
      appendCastleLaneRecord(path, {
        at: "2026-07-16T20:04:00.000Z",
        kind: "worker.claimed",
        worker_id: "wAB12",
        unknown: "not part of the published lane family",
      } as never),
    ).rejects.toBeInstanceOf(CastleLaneValidationError);

    expect(existsSync(path)).toBe(false);
  });
});
