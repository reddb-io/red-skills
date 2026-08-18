import { existsSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANE_RETENTION_REGISTRY } from "@reddb-io/shared/lane-retention.js";
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

  it("caps a LINE-only lane on append and keeps the newest rows (#3645)", async () => {
    const paths = createEnginePaths(redRoot);
    const maxLines = 6;

    for (let outcome = 1; outcome <= 12; outcome += 1) {
      await appendCastleHistoryRecord(paths.castleHistory, {
        ts: "2026-07-16T20:03:00.000Z",
        epoch: 1784232180,
        worker: "wAB12",
        issue: 1900 + outcome,
        event: "done",
        duration_s: 12,
        runner: "codex",
      }, { retentionPolicy: { maxLines, targetRatio: 0.5 } });
      const rows = parseRecords(await readFile(paths.castleHistory, "utf8"));
      // Bounded after EVERY append, not only after the last one — a boot-time
      // sweep would have let the ledger grow between restarts.
      expect(rows.length).toBeLessThanOrEqual(maxLines);
    }

    const kept = parseRecords(await readFile(paths.castleHistory, "utf8"));
    expect(kept.at(-1)?.issue).toBe(1912);
    expect(kept.length).toBeLessThan(12);
  });

  it("bounds castle history by the registry's line ceiling with no policy passed", async () => {
    const paths = createEnginePaths(redRoot);

    await appendCastleHistoryRecord(paths.castleHistory, {
      ts: "2026-07-16T20:03:00.000Z",
      epoch: 1784232180,
      worker: "wAB12",
      issue: 1905,
      event: "done",
      duration_s: 12,
      runner: "codex",
    });

    expect(LANE_RETENTION_REGISTRY["castle-history"].maxLines).toBe(10_000);
    expect(parseRecords(await readFile(paths.castleHistory, "utf8"))).toHaveLength(1);
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
