/**
 * Pins the worker partition introduced by #2345, after the Fleet's removal.
 *
 * There is one supervisor lane per project now, so the question the partition
 * answers changed from "which fleet owns this worker" to "did THIS project's
 * supervisor spawn it": a worker stamped with the project's lane is reported in
 * `live_workers`, and a worker carrying any other stamp is reported in
 * `unattributed_workers` rather than silently counted as ours.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  castleStateSnapshotPath,
  createCastleLaneWriters,
  createEnginePaths,
  PROJECT_SUPERVISOR_LANE,
  writeCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import { afterEach, describe, expect, it } from "vitest";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";

// Snapshot timestamps are fixed; liveness records use real wall-clock time so
// the 180-second idle window in readCastleMonitorWorkers sees them as fresh.
const SNAPSHOT_ISO = "2026-07-21T12:00:00.000Z";

function workerSnapshot(
  id: string,
  issue: number,
  pid: number,
  lane: string,
) {
  return {
    kind: "worker" as const,
    id,
    worker_id: id,
    version: 1,
    updated_at: SNAPSHOT_ISO,
    started_at: SNAPSHOT_ISO,
    runner: "claude",
    pid,
    supervisor_id: lane,
    current: {
      origin: "afk",
      number: issue,
      title: `Issue ${issue}`,
      activity: "implementing",
      phase: "implementing",
    },
    queue: [issue],
    completed: [],
    envelope: { posted: false },
  };
}

describe("project_status worker partition (#2345)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("counts the project's own workers and sets a foreign stamp aside", async () => {
    const root = await mkdtemp(join(tmpdir(), "project-partition-"));
    roots.push(root);

    const enginePaths = createEnginePaths(join(root, ".red"));
    // Liveness records use real wall-clock time so the 180-second idle window in
    // readCastleMonitorWorkers sees them as fresh (no fixed clock injected).
    const lanes = createCastleLaneWriters(enginePaths);

    await writeCastleStateSnapshot(
      castleStateSnapshotPath(enginePaths, "worker", "w_mine"),
      workerSnapshot("w_mine", 100, 1001, PROJECT_SUPERVISOR_LANE),
    );
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(enginePaths, "worker", "w_foreign"),
      workerSnapshot("w_foreign", 200, 2001, "some-other-lane"),
    );

    for (const [workerId, issue] of [["w_mine", 100], ["w_foreign", 200]] as const) {
      await lanes.liveness(workerId).append({
        kind: "worker.heartbeat",
        worker_id: workerId,
        issue,
        payload: {},
      });
    }

    // A minimal supervisor snapshot so readFleetState does not return null; the
    // slot-pid fallback is not exercised here because both workers are stamped.
    const supervisorDir = join(root, ".red", "tmp", "supervisors", PROJECT_SUPERVISOR_LANE);
    await mkdir(supervisorDir, { recursive: true });
    await writeFile(
      join(supervisorDir, "state.toon"),
      encodeDevSnapshotToon({
        ts: new Date().toISOString(),
        epoch: Math.floor(Date.now() / 1000),
        runner: "claude",
        ready_for_agent: 0,
        slots: { busy: 1, free: 0, total: 1, parked: 0 },
        spawns_this_tick: 1,
        churn: { deaths: 0, respawns: 0, window_s: 300 },
      }),
    );

    const status = (await createCastleMcpDependencies(root).projectStatus()) as {
      live_workers: Array<{ id: string }>;
      unattributed_workers: Array<{ id: string }>;
    };

    const live = status.live_workers.map((w) => w.id);
    const unattributed = status.unattributed_workers.map((w) => w.id);
    expect(live).toContain("w_mine");
    expect(live).not.toContain("w_foreign");
    expect(unattributed).toContain("w_foreign");
    expect(unattributed).not.toContain("w_mine");
  });
});
