/**
 * Pins the multi-fleet worker partition introduced by #2345.
 *
 * Two named fleets ("alpha" and "beta") each own one live worker, stamped with
 * their fleet via `supervisor_id` in the castle state snapshot.  Each
 * `fleet_status` call must report only its own worker in `live_workers` and
 * place the other fleet's worker in `unattributed_workers`.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  castleStateSnapshotPath,
  createCastleLaneWriters,
  createEnginePaths,
  writeCastleStateSnapshot,
} from "@reddb-io/red-castle/engine";
import { afterEach, describe, expect, it } from "vitest";
import { createDevAfkMcpDependencies } from "../src/mcp-adapter.js";
import { encodeDevSnapshotToon } from "../src/core/toon-snapshot.js";

const NOW_ISO = "2026-07-21T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const NOW_EPOCH = Math.floor(NOW_MS / 1000);

function workerSnapshot(
  id: string,
  issue: number,
  pid: number,
  fleetName: string,
) {
  return {
    kind: "worker" as const,
    id,
    worker_id: id,
    version: 1,
    updated_at: NOW_ISO,
    started_at: NOW_ISO,
    runner: "claude",
    pid,
    supervisor_id: fleetName,
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

describe("fleet_status worker partition (#2345)", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("partitions stamped workers to their owning fleet", async () => {
    const root = await mkdtemp(join(tmpdir(), "fleet-partition-"));
    roots.push(root);

    const enginePaths = createEnginePaths(join(root, ".red"));
    const lanes = createCastleLaneWriters(enginePaths, {
      clock: () => NOW_ISO,
    });

    // Write castle state snapshots — each stamped with their owning fleet.
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(enginePaths, "worker", "w_alpha"),
      workerSnapshot("w_alpha", 100, 1001, "alpha"),
    );
    await writeCastleStateSnapshot(
      castleStateSnapshotPath(enginePaths, "worker", "w_beta"),
      workerSnapshot("w_beta", 200, 2001, "beta"),
    );

    // Write recent liveness lane records so both workers appear live to the monitor.
    await lanes.liveness("w_alpha").append({
      kind: "worker.heartbeat",
      worker_id: "w_alpha",
      issue: 100,
      payload: {},
    });
    await lanes.liveness("w_beta").append({
      kind: "worker.heartbeat",
      worker_id: "w_beta",
      issue: 200,
      payload: {},
    });

    // Write minimal fleet-state files so readFleetState doesn't return null.
    // The slot_pids fallback isn't exercised here (all workers have stamps),
    // but the epoch field prevents parseFleetState from returning null.
    const fleetState = (epoch: number) =>
      encodeDevSnapshotToon({
        ts: NOW_ISO,
        epoch,
        runner: "claude",
        ready_for_agent: 0,
        slots: { busy: 1, free: 0, total: 1, parked: 0 },
        spawns_this_tick: 1,
        churn: { deaths: 0, respawns: 0, window_s: 300 },
      });

    const alphaSupervisorDir = join(root, ".red", "tmp", "supervisors", "alpha");
    const betaSupervisorDir = join(root, ".red", "tmp", "supervisors", "beta");
    await mkdir(alphaSupervisorDir, { recursive: true });
    await mkdir(betaSupervisorDir, { recursive: true });
    await writeFile(join(alphaSupervisorDir, "state.toon"), fleetState(NOW_EPOCH));
    await writeFile(join(betaSupervisorDir, "state.toon"), fleetState(NOW_EPOCH));

    // Use a fixed nowMs so liveness records (written at NOW_ISO) are within the
    // 180-second idle window — they appear as NOW_MS which equals nowMs exactly.
    const mcp = createDevAfkMcpDependencies(root);

    const alphaStatus = await mcp.fleetStatus({ name: "alpha" });
    const betaStatus = await mcp.fleetStatus({ name: "beta" });

    // Alpha fleet: sees its own worker, not beta's.
    const alphaLive = alphaStatus.live_workers.map((w: { id: string }) => w.id);
    const alphaUnattributed = alphaStatus.unattributed_workers.map(
      (w: { id: string }) => w.id,
    );
    expect(alphaLive).toContain("w_alpha");
    expect(alphaLive).not.toContain("w_beta");
    expect(alphaUnattributed).not.toContain("w_alpha");

    // Beta fleet: sees its own worker, not alpha's.
    const betaLive = betaStatus.live_workers.map((w: { id: string }) => w.id);
    const betaUnattributed = betaStatus.unattributed_workers.map(
      (w: { id: string }) => w.id,
    );
    expect(betaLive).toContain("w_beta");
    expect(betaLive).not.toContain("w_alpha");
    expect(betaUnattributed).not.toContain("w_beta");
  });
});
