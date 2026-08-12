// One Worker stop took the whole machine's daemon off the air for ninety
// seconds, and every MCP client on the host read that as a dead daemon.
//
// The stop asked `systemctl --user stop <unit>` and WAITED for the job to
// finish. A runner that ignores SIGTERM does not finish it — the unit sits in
// `deactivating (stop-sigterm)` until `TimeoutStopSec` escalates to SIGKILL —
// and because the request was placed with `spawnSync`, the daemon's event loop
// was held for the whole of it. Workers are `--once` and recycle constantly, so
// this fired many times an hour, and each time a `ping` with a ten-second
// deadline came back as "daemon unreachable".
//
// These checks pin the three things the fix owes: a read still answers while a
// stop is in flight, the stop's own answer still means the host confirmed the
// death, and one Worker is still one death however many callers ask at once.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRedskilledHostState } from "../src/client.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane, readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest, type RedskilledWorkerCommandResult } from "../src/protocol.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-stop-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function workerView(): RedskilledWorkerView {
  return {
    worker_id: "w-sigterm-deaf",
    project_label: "reddb-io/red-skills",
    pid: 4_242,
    pgid: 4_242,
    started_at: "2026-08-11T10:00:00.000Z",
    workspace_path: "/tmp/workspace",
    isolated: true,
    unit: "red-worker-reddb-io-red-skills-w-sigterm-deaf.service",
    warnings: [],
  };
}

/**
 * A stop that has been asked for and has not come back — the wedge, posed.
 *
 * The daemon's real stop escalates to a process-group kill and resolves in
 * seconds; what a test needs is the shape, not the duration, so the host's
 * confirmation is a promise the test settles by hand. `entered` is how a check
 * knows the daemon is genuinely inside the stop rather than about to be.
 */
function poseSlowStop() {
  let confirm: (confirmed: boolean) => void = () => undefined;
  let announceEntry: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    announceEntry = resolve;
  });
  const confirmed = new Promise<boolean>((resolve) => {
    confirm = resolve;
  });
  let calls = 0;
  return {
    entered,
    calls: () => calls,
    confirm,
    stopWorker: () => {
      calls += 1;
      announceEntry();
      return confirmed;
    },
  };
}

/**
 * Ask the daemon to stop one Worker, on the wire and with no client wrapper.
 *
 * The raw request is deliberate: it connects the instant it is called, so two of
 * them reach the daemon in the order they were written, which is what lets an
 * overlap be posed rather than hoped for.
 */
function commandStop(paths: RedskilledPaths, id: string): Promise<RedskilledWorkerCommandResult> {
  return sendRedskilledRequest(
    { socketPath: paths.socketPath, timeoutMs: 5_000 },
    { id, op: "worker-command", command: { command: "stop", worker_id: "w-sigterm-deaf" } },
  ).then((response) => {
    if (!response.ok) throw new Error(response.error);
    return response.value as RedskilledWorkerCommandResult;
  });
}

/** Put one live Worker on the lane and adopt it into a fresh daemon. */
async function daemonHoldingOneWorker(
  paths: RedskilledPaths,
  stopWorker: () => Promise<boolean>,
): Promise<RedskilledDaemon> {
  const lane = createRedskilledEventLane(paths.eventLanePath);
  await lane.record({ event: "worker-birth", worker: workerView(), ts: "2026-08-11T10:00:00.000Z" });
  const daemon = await startRedskilledDaemon({
    paths,
    idleMs: 60_000,
    sampleMs: 0,
    liveness: () => true,
    stopWorker,
    // The host running this suite has Workers of its own; the daemon under test
    // holds exactly the one the lane gave it.
    unitInventory: () => [],
  });
  running.push(daemon);
  expect(daemon.workerCount()).toBe(1);
  return daemon;
}

describe("a Worker stop the host is slow to confirm", () => {
  it("answers ping and host-state while the stop is still in flight", async () => {
    const paths = await sessionPaths();
    const stop = poseSlowStop();
    await daemonHoldingOneWorker(paths, stop.stopWorker);

    const commanded = commandStop(paths, "stop-1");
    await stop.entered;

    // The reads that every session on the machine makes, taken at the one
    // instant the old daemon could not take them. `socketAnswers` is the
    // diagnosis's own probe: a bare `ping` with a quarter-second deadline, which
    // a wedged dispatcher fails by saying nothing.
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    const state = await readRedskilledHostState(paths);
    // Still held: a Worker whose death nobody has confirmed is a Worker, and
    // reporting the slot free here would let the next admission double-spend it.
    expect(state.workers.map((worker) => worker.worker_id)).toEqual(["w-sigterm-deaf"]);

    stop.confirm(true);
    await commanded;
  });

  it("reports the stop applied only once the host confirmed the death", async () => {
    const paths = await sessionPaths();
    const stop = poseSlowStop();
    const daemon = await daemonHoldingOneWorker(paths, stop.stopWorker);

    const commanded = commandStop(paths, "stop-1");
    await stop.entered;
    // The acknowledgement is not a receipt for the request: while the host has
    // confirmed nothing, the caller has been told nothing and the slot stands.
    expect(daemon.workerCount()).toBe(1);

    stop.confirm(true);
    const result = await commanded;

    expect({ applied: result.applied, command: result.command }).toEqual({ applied: true, command: "stop" });
    expect(result.detail).toContain("redskilled stopped Worker");
    expect(daemon.workerCount()).toBe(0);
  });

  it("records one death and frees one slot when two callers stop the same Worker at once", async () => {
    const paths = await sessionPaths();
    const stop = poseSlowStop();
    const daemon = await daemonHoldingOneWorker(paths, stop.stopWorker);

    const first = commandStop(paths, "stop-1");
    await stop.entered;
    const second = commandStop(paths, "stop-2");
    // A round trip opened AFTER the second stop, and answered: the daemon takes
    // its connections in the order they arrived, so an answer here is proof the
    // second stop has already been dispatched and is genuinely overlapping the
    // first rather than racing the confirmation below.
    expect(await socketAnswers(paths.socketPath)).toBe(true);

    stop.confirm(true);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    await daemon.flushEvents();

    // Both callers are answered truthfully — the Worker they asked about is
    // gone — and the host was asked to kill it exactly once.
    expect([firstResult.applied, secondResult.applied]).toEqual([true, true]);
    expect(stop.calls()).toBe(1);
    expect(daemon.workerCount()).toBe(0);
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.filter((event) => event.event === "worker-death")).toHaveLength(1);
  });
});
