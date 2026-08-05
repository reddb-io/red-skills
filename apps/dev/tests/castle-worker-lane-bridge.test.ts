import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  castleLanePath,
  castleStateSnapshotPath,
  createEnginePaths,
  readCastleLaneRecords,
  readCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import { parseLivenessRecords } from "@reddb-io/red-castle";
import { initStateSync } from "../src/core/state.js";
import {
  createBootCastleWorkerLaneBridge,
  createCastleWorkerLaneBridge,
} from "../src/core/castle-worker-lane-bridge.js";

describe("createCastleWorkerLaneBridge", () => {
  it("opens a Worker's structured lane with its Validation moment schedule, including skips", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-worker-boot-schedule-"));
    const redRoot = join(root, ".red");
    const workerId = "wSCHED";

    await createBootCastleWorkerLaneBridge({
      redRoot,
      workerId,
      attemptDir: () => "",
      nowIso: () => "2026-08-04T20:00:00.000Z",
      nowMs: () => Date.parse("2026-08-04T20:00:00.000Z"),
    }, {
      iteration: ["pnpm test", "pnpm typecheck"],
      landing: [],
    });

    const records = await readCastleLaneRecords(
      castleLanePath(createEnginePaths(redRoot), "worker", workerId),
    );
    expect(records[0]).toMatchObject({
      kind: "worker.validation_schedule",
      payload: {
        narration:
          "Validation moments — iteration: declared [pnpm test; pnpm typecheck]; " +
          "post_done: skip (undeclared); landing: skip (empty declaration)",
        iteration: "declared",
        post_done: "skip",
        landing: "skip",
      },
    });
  });

  it("writes worker lifecycle, liveness, and state snapshot as honest TOON lanes", async () => {
    const root = await mkdtemp(join(tmpdir(), "castle-worker-lane-"));
    const redRoot = join(root, ".red");
    const workerId = "wAB12";
    const attemptDir = join(redRoot, "tmp", "workers", workerId, "2064-a1");
    await mkdir(attemptDir, { recursive: true });
    initStateSync(join(attemptDir, "afk.state.toon"), {
      worker_id: workerId,
      pid: 1234,
      runner: "codex",
      origin: "afk",
      started_at: "2026-07-17T00:00:00.000Z",
      "current.kind": "afk",
      "current.number": 2064,
      "current.title": "Structured lane worker records",
      "current.activity": "setup",
      "current.phase": "setup",
    });
    const bridge = createCastleWorkerLaneBridge({
      redRoot,
      workerId,
      attemptDir: () => attemptDir,
      nowIso: () => "2026-07-17T00:00:01.000Z",
      nowMs: () => Date.parse("2026-07-17T00:00:01.000Z"),
    });

    await bridge.log("preparing worktree");
    await bridge.record(
      "worker.heartbeat",
      { signal: "vitals-sampler" },
      "gate still running",
    );

    const paths = createEnginePaths(redRoot);
    const workerPath = castleLanePath(paths, "worker", workerId);
    const livenessPath = castleLanePath(paths, "liveness", workerId);
    expect(workerPath.endsWith("worker.log.toonl")).toBe(true);
    expect(livenessPath.endsWith("liveness.toonl")).toBe(true);

    await expect(readFile(workerPath, "utf8")).resolves.toContain("preparing worktree");
    await expect(readFile(livenessPath, "utf8")).resolves.toContain("worker.heartbeat");

    const workerRecords = await readCastleLaneRecords(workerPath);
    expect(workerRecords).toEqual([
      expect.objectContaining({ kind: "worker.log", msg: "preparing worktree" }),
      expect.objectContaining({
        kind: "worker.heartbeat",
        msg: "gate still running",
        worker_id: workerId,
        issue: 2064,
        attempt: 1,
      }),
    ]);

    for (const redundant of ["afk.log", "agent.log.toonl", "log.toonl"]) {
      await expect(access(join(attemptDir, redundant))).rejects.toMatchObject({ code: "ENOENT" });
    }

    const attemptLiveness = parseLivenessRecords(await readFile(join(attemptDir, "liveness.toonl"), "utf8"));
    expect(attemptLiveness).toEqual([
      expect.objectContaining({ at: Date.parse("2026-07-17T00:00:01.000Z") }),
    ]);

    const snapshot = await readCastleStateSnapshot(castleStateSnapshotPath(paths, "worker", workerId));
    expect(snapshot).toEqual(expect.objectContaining({
      kind: "worker",
      id: workerId,
      worker_id: workerId,
      runner: "codex",
      pid: 1234,
    }));
    expect(snapshot?.current).toEqual(expect.objectContaining({
      number: 2064,
      title: "Structured lane worker records",
      origin: "afk",
    }));
  });
});
