// A dead Worker's record occupied a slot forever, and no verb could release it
// (#3123).
//
// The pid was dead, the systemd unit was gone, and the record was two hours old.
// The daemon still said `host 1w/1p` and refused to birth anything at `target: 1`
// while eight ready issues sat undrained. The sweep it already ran only ever
// asked about RE-ATTACHED Workers — the ones adopted across a restart — so a
// record born here whose launch client died without delivering an exit was never
// asked about at all.
//
// These checks pin the reaping and its cadence: the record goes on the liveness
// sweep, WITHOUT a daemon restart, and the sweep runs before a birth decision
// rather than only when the machine goes idle. The newborn grace is pinned too,
// because the opposite bug — reaping a Worker mid-birth — is the one a wider
// sweep invites.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedskilledEventLane, readRedskilledEvents } from "../src/event-lane.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-reap-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function workerView(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "71982926-abf",
    project_label: "reddb-io/red-skills",
    pid: 3275525,
    started_at: "2026-08-03T01:52:04.000Z",
    workspace_path: "/tmp/workspace",
    isolated: true,
    unit: "red-worker-reddb-io-red-skills-71982926.service",
    warnings: [],
    ...overrides,
  };
}

describe("a record whose Worker is gone is reaped on the liveness sweep", () => {
  it("reaps a two-hour-old record with a dead pid and an absent unit", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView(), ts: "2026-08-03T01:52:04.000Z" });

    // Adopted at start because the host still confirmed it, then the unit went
    // away: exactly the shape a record acquires between two sweeps.
    let confirmed = true;
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      liveness: () => confirmed,
      livenessGraceMs: 0,
    });
    running.push(daemon);
    expect(daemon.workerCount()).toBe(1);

    confirmed = false;
    const reaped = await daemon.sweepWorkerLiveness();
    await daemon.flushEvents();

    expect(reaped.map((worker) => worker.worker_id)).toEqual(["71982926-abf"]);
    // No restart was needed, and the slot is free.
    expect(daemon.workerCount()).toBe(0);
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.at(-1)!.event).toBe("worker-death");
  });

  it("frees the slot before the birth decision, not only when the machine idles", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({ event: "worker-birth", worker: workerView(), ts: "2026-08-03T01:52:04.000Z" });

    let confirmed = true;
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 300_000,
      liveness: () => confirmed,
      livenessGraceMs: 0,
    });
    running.push(daemon);
    expect(daemon.workerCount()).toBe(1);

    confirmed = false;
    // The demand tick is where `target: 1` was refused against a phantom Worker.
    // Its own sweep is what makes the refusal impossible, five minutes before the
    // idle timer would have noticed.
    await daemon.driveDemand();

    expect(daemon.workerCount(), "the demand tick judged its targets against a dead record").toBe(0);
  });

  it("leaves a newborn alone — a Worker mid-birth is not a Worker that died", async () => {
    const paths = await sessionPaths();
    const workspace = await mkdtemp(join(tmpdir(), "redskilled-reap-ws-"));
    roots.push(workspace);
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      // Nothing this daemon holds is confirmed, so only the grace can save it.
      liveness: () => false,
      livenessGraceMs: 30_000,
    });
    running.push(daemon);

    daemon.startWorker({
      project_label: "acme/widgets",
      workspace_path: workspace,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 3_000)"],
      budget: { memory_high: "512M" },
    });

    const reaped = await daemon.sweepWorkerLiveness();

    expect(reaped, "a Worker born a moment ago was swept as dead").toEqual([]);
    expect(daemon.workerCount()).toBe(1);
  });
});
