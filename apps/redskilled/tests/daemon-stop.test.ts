// Stop is something you ask for, not something you signal (#2919). A hand-sent
// SIGTERM ends the same process and can say nothing about what it was holding; a
// stop command states the Workers that survive it, writes the intent to the host
// event lane so a successor can tell a handover from a crash, and answers a
// machine with no daemon on it with a reason instead of an error.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPidAlive } from "@reddb-io/shared/resident-core.js";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { runStop } from "../src/cli.js";
import {
  readRedskilledHostState,
  startRedskilledWorker,
  stopRedskilledDaemon,
} from "../src/client.js";
import { birthRedskilledDaemon } from "../src/daemon-birth.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  buildRedskilledNotRunningStop,
  buildRedskilledStopReport,
  isRedskilledDaemonStopped,
} from "../src/daemon-stop.js";
import { lastRedskilledDaemonStop, readRedskilledEvents, rehydrateWorkers } from "../src/event-lane.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { readRedskilledLeaseFile } from "../src/session-lease.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const spawnedPids: number[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-stop-"));
  roots.push(root);
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

async function startSilentHolder(paths: RedskilledPaths): Promise<number> {
  const child = spawn(process.execPath, [
    "-e",
    `
      const { unlinkSync } = require("node:fs");
      const { createServer } = require("node:net");
      const [socketPath, leasePath] = process.argv.slice(1);
      const server = createServer(() => {});
      server.listen(socketPath, () => process.stdout.write("ready\\n"));
      process.on("SIGTERM", () => {
        try { unlinkSync(leasePath); } catch {}
        process.exit(0);
      });
      setInterval(() => {}, 1_000);
    `,
    paths.socketPath,
    paths.leasePath,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  if (child.pid == null) throw new Error("silent holder did not start");
  const pid = child.pid;
  spawnedPids.push(pid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`silent holder exited before ready (${code})`)));
    child.stdout!.once("data", () => resolve());
  });
  await writeFile(paths.leasePath, `${encode({
    version: 1,
    pid,
    start_time: new Date().toISOString(),
    session_key_hash: paths.sessionKeyHash,
    machine_id_hash: paths.machineIdHash,
    socket_path: paths.socketPath,
    acquired_at: new Date().toISOString(),
    renewed_at: new Date().toISOString(),
  } as JsonValue)}\n`, "utf8");
  return pid;
}

function clientConfig(paths: RedskilledPaths) {
  return {
    serverCommand: process.execPath,
    serverArgs: ["--import", tsxLoader, cliEntry],
    readyTimeoutMs: 20_000,
    env: {
      ...process.env,
      REDSKILLED_SESSION: `test:${paths.runtimeDir}`,
      REDSKILLED_PLACEMENT: "off",
    },
  };
}

const WORKER = {
  worker_id: "w-1",
  project_label: "alpha",
  pid: 4242,
  started_at: "2026-07-31T10:00:00.000Z",
  workspace_path: "/workspaces/alpha",
  isolated: true,
  unit: "red-worker-alpha-w-1.service",
  warnings: [] as string[],
};

const UNISOLATED = {
  worker_id: "w-2",
  project_label: "beta",
  pid: 4343,
  started_at: "2026-07-31T10:01:00.000Z",
  workspace_path: "/workspaces/beta",
  isolated: false,
  warnings: ["started without a transient unit"],
};

describe("redskilled stop report", () => {
  it("names every held Worker and the projects they belong to", () => {
    const report = buildRedskilledStopReport({
      reason: "requested",
      socketPath: "/run/redskilled.sock",
      daemonVersion: "3.0.2",
      pid: 99,
      workers: [WORKER, UNISOLATED],
      projects: ["gamma"],
    });

    expect(report.running).toBe(true);
    expect(report.stopped).toBe(true);
    expect(report.holding.workers.map((worker) => worker.worker_id)).toEqual(["w-1", "w-2"]);
    expect(report.holding.projects).toEqual(["alpha", "beta", "gamma"]);
    expect(report.detail).toContain("2 Workers across 3 projects");
    expect(report.detail).toContain("an operator asked for it");
  });

  it("states which surviving Workers remain contained after the stop", () => {
    const report = buildRedskilledStopReport({
      reason: "requested",
      socketPath: "/run/redskilled.sock",
      daemonVersion: "3.0.2",
      pid: 99,
      workers: [WORKER, UNISOLATED],
    });

    // Every Worker is detached — isolated ones as init-system units — so a stop is
    // a restart and never an evacuation.
    expect(report.surviving).toEqual(["w-1", "w-2"]);
    expect(report.holding.workers.every((worker) => worker.survives)).toBe(true);
    expect(report.holding.workers.map((worker) => [worker.worker_id, worker.contained])).toEqual([
      ["w-1", true],
      ["w-2", false],
    ]);
    expect(report.detail).toContain("1 uncontained survivor");
    expect(isRedskilledDaemonStopped(report)).toBe(true);
    const [{ contained: _contained, ...incomplete }, ...rest] = report.holding.workers;
    expect(isRedskilledDaemonStopped({
      ...report,
      holding: { ...report.holding, workers: [incomplete, ...rest] },
    })).toBe(false);
  });

  it("says a daemon holding nothing leaves nothing behind", () => {
    const report = buildRedskilledStopReport({
      reason: "requested",
      socketPath: "/run/redskilled.sock",
      daemonVersion: "3.0.2",
      pid: 99,
      workers: [],
    });

    expect(report.surviving).toEqual([]);
    expect(report.detail).toContain("holds no Workers");
  });

  it("reports a socket nobody answers on as a success with a reason", () => {
    const report = buildRedskilledNotRunningStop("/run/redskilled.sock");

    expect(report.running).toBe(false);
    expect(report.stopped).toBe(false);
    expect(report.reason).toBe("not-running");
    expect(report.detail).toContain("there was nothing to stop");
  });
});

describe("redskilled stop", () => {
  it("returns only after the daemon process exits and releases the lease while its Worker survives", async () => {
    const paths = await sessionPaths();
    const config = clientConfig(paths);
    // Provisioning is the one route to a daemon now; a client only ever finds one.
    await birthRedskilledDaemon(paths, config);
    const state = await readRedskilledHostState(paths, config);
    spawnedPids.push(state.pid);
    const worker = await startRedskilledWorker(paths, {
      project_label: "alpha",
      workspace_path: paths.runtimeDir,
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 30_000)"],
      log_path: join(paths.runtimeDir, "worker.toonl"),
      placement: { isolation: "inherit" },
    }, config);
    spawnedPids.push(worker.worker.pid);

    // The settle is a DEADLINE with an early return, so a generous one costs
    // nothing when the drain is quick. At 2s this test was stricter than the
    // product's own 5s default and failed on a loaded 4-core runner while
    // passing here — `stopped: false` means only "did not finish the bounded
    // drain in time", which says nothing about the behaviour under test.
    const report = await stopRedskilledDaemon(paths, { settleTimeoutMs: 20_000 });

    expect(report.stopped).toBe(true);
    expect(isPidAlive(state.pid)).toBe(false);
    expect(await readRedskilledLeaseFile(paths.leasePath)).toBeUndefined();
    expect(isPidAlive(worker.worker.pid)).toBe(true);
  }, 60_000);

  it("shuts the daemon down and reports what it was holding", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, daemonVersion: "3.0.2" });
    running.push(daemon);
    daemon.trackWorker(WORKER);

    const report = await stopRedskilledDaemon(paths, { detail: "moving this host to 3.0.3" });

    expect(report.running).toBe(true);
    expect(report.stopped).toBe(true);
    expect(report.daemon_version).toBe("3.0.2");
    expect(report.holding.workers.map((worker) => worker.worker_id)).toEqual(["w-1"]);
    expect(report.surviving).toEqual(["w-1"]);
    // Stopped means the socket is free, not merely that the request was taken.
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  });

  it("records the stop on the host event lane, with the operator's words", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, daemonVersion: "3.0.2" });
    running.push(daemon);
    daemon.trackWorker(WORKER);

    await stopRedskilledDaemon(paths, { detail: "moving this host to 3.0.3" });

    const events = await readRedskilledEvents(paths.eventLanePath);
    const stop = lastRedskilledDaemonStop(events);
    expect(stop?.event).toBe("daemon-stop");
    expect(stop?.reason).toBe("requested");
    expect(stop?.detail).toContain("moving this host to 3.0.3");
    // The stop is the LAST thing on the lane: a successor reads the departure
    // rather than inferring one from a lane that simply ends.
    expect(events.at(-1)).toEqual(stop);
  });

  it("leaves the replay untouched, so the successor still adopts the survivors", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);
    daemon.trackWorker(WORKER);

    await stopRedskilledDaemon(paths);

    const events = await readRedskilledEvents(paths.eventLanePath);
    // A daemon's own departure retires no Worker: the Workers it held are still
    // running, which is exactly what the successor replays to find.
    expect(rehydrateWorkers(events).map((worker) => worker.worker_id)).toEqual(["w-1"]);
  });

  it("names a signal as itself, not as a request", async () => {
    const signalPaths = await sessionPaths();
    const signalled = await startRedskilledDaemon({ paths: signalPaths });
    running.push(signalled);
    await signalled.stop({ reason: "signal", signal: "SIGTERM" });
    const stop = lastRedskilledDaemonStop(await readRedskilledEvents(signalPaths.eventLanePath));
    expect(stop?.reason).toBe("signal");
    expect(stop?.signal).toBe("SIGTERM");
  });

  it("writes the departure once, however many callers ask at once", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    await Promise.all([daemon.stop(), daemon.stop(), daemon.stop()]);

    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.filter((event) => event.event === "daemon-stop")).toHaveLength(1);
  });

  it("succeeds with a stated reason when no daemon is running", async () => {
    const paths = await sessionPaths();

    const report = await stopRedskilledDaemon(paths);

    expect(report.running).toBe(false);
    expect(report.stopped).toBe(false);
    expect(report.reason).toBe("not-running");
    // And it never births the very daemon it was asked to remove.
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  });

  it("signals an alive socket holder that does not answer and distinguishes it from absence", async () => {
    const paths = await sessionPaths();
    const pid = await startSilentHolder(paths);

    // Same reasoning as the settle above: signalling a holder and confirming the
    // pid is gone is not instant on a busy machine, and the deadline returns
    // early when it is.
    const report = await stopRedskilledDaemon(paths, { settleTimeoutMs: 20_000 });

    expect(report.running).toBe(true);
    expect(report.stopped).toBe(true);
    expect(report.reason).toBe("unreachable");
    expect(report.pid).toBe(pid);
    expect(report.daemon_version).toBeNull();
    expect(report.detail).toContain("did not answer");
    expect(isPidAlive(pid)).toBe(false);
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  });

  it("reports what it can see WITHOUT stopping anything", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);
    daemon.trackWorker(WORKER);

    const preview = daemon.stopReport();

    expect(preview.holding.workers).toHaveLength(1);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
  });
});

describe("redskilled stop command", () => {
  it("prints the report and exits zero", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);
    daemon.trackWorker(WORKER);
    let printed = "";

    const code = await runStop(["--reason", "replacing the bundle"], { paths, write: (text) => {
      printed += text;
    } });

    expect(code).toBe(0);
    expect(printed).toContain("stopped");
    expect(printed).toContain("w-1");
    expect(decode(printed)).toMatchObject({
      workers: [{ worker_id: "w-1", contained: true }],
    });
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  });

  it("exits zero on a machine with no daemon, stating why", async () => {
    const paths = await sessionPaths();
    let printed = "";

    const code = await runStop([], { paths, write: (text) => {
      printed += text;
    } });

    expect(code).toBe(0);
    expect(printed).toContain("not-running");
    expect(printed).toContain("nothing to stop");
  });
});
