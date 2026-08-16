import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { commandRedskilledWorker } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { launchWorker, type RedskilledWorkerSpec } from "../src/worker-launch.js";
import {
  planWorkerPlacement,
  WorkerPlacementAdmissionRefusal,
  type WorkerPlacementDriver,
  type WorkerPlacementProbes,
} from "../src/worker-placement.js";

const roots: string[] = [];
const daemons: RedskilledDaemon[] = [];
const DRIVERS = ["native", "docker", "podman"] as const satisfies readonly WorkerPlacementDriver[];

const PROBES: WorkerPlacementProbes = {
  platform: "linux",
  systemdRun: "/usr/bin/systemd-run",
  userSession: true,
  jobObjects: { available: false, reason: "not Windows" },
  posix: { available: true, shell: "/bin/sh", nice: null },
  containerEngines: { docker: "/usr/bin/docker", podman: "/usr/bin/podman" },
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function paths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-placement-contract-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `placement:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function spec(driver: WorkerPlacementDriver, workerId: string): RedskilledWorkerSpec {
  return {
    worker_id: workerId,
    project_label: "acme/widgets",
    workspace_path: "/workspace",
    command: "/usr/bin/node",
    args: ["worker.js"],
    placement: {
      isolation: "transient-unit",
      allowed_drivers: [driver],
      container_image: "example.test/red-worker:fixture",
    },
  };
}

function fakeChild(pid: number): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid, stdin: null, stdout: null, stderr: null, unref() {} });
  return child;
}

describe("Worker placement admission", () => {
  it("refuses deterministically when host policy and Project requirements share no available driver", () => {
    expect(() => planWorkerPlacement({
      workerId: "w-refused",
      projectLabel: "acme/widgets",
      workspacePath: "/workspace",
      command: "/usr/bin/node",
      probes: { ...PROBES, containerEngines: { docker: null, podman: null } },
      driverPolicy: { allowed_drivers: ["docker", "podman"] },
      target: {
        isolation: "transient-unit",
        allowed_drivers: ["docker"],
        container_image: "example.test/red-worker:fixture",
      },
    })).toThrowError(WorkerPlacementAdmissionRefusal);
  });
});

describe.each(DRIVERS)("%s placement shared lifecycle", (driver) => {
  it("lets redskilled alone create, observe, cancel, replace, and reap the Worker", async () => {
    const daemonPaths = await paths();
    const alive = new Set<string>();
    let births = 0;
    let stops = 0;
    const daemon = await startRedskilledDaemon({
      paths: daemonPaths,
      idleMs: 60_000,
      ceiling: UNBOUNDED_HOST_CEILING,
      livenessGraceMs: 0,
      liveness: (worker) => alive.has(worker.worker_id),
      stopWorker: (worker) => {
        stops += 1;
        alive.delete(worker.worker_id);
        return true;
      },
      launch: (options) => {
        births += 1;
        const launched = launchWorker({
          ...options,
          probes: PROBES,
          openLog: false,
          spawnFn: (_command: string, _args: readonly string[], _spawn: SpawnOptions) => fakeChild(40_000 + births),
        });
        alive.add(launched.worker.worker_id);
        return launched;
      },
    });
    daemons.push(daemon);

    const first = daemon.startWorker(spec(driver, `w-${driver}-1`));
    expect(first.plan.driver).toBe(driver);
    if (driver === "native") {
      expect(first.plan.backend).toBe("transient-unit");
      expect(first.worker.unit).toMatch(/\.service$/);
    } else {
      expect(first.plan.backend).toBe(driver);
      expect(first.plan.command).toBe(`/usr/bin/${driver}`);
      expect(first.plan.args).toContain("example.test/red-worker:fixture");
      expect(first.plan.args).toContain("--volume=/workspace:/workspace");
      expect(first.worker.unit).toMatch(new RegExp(`^${driver}://`));
    }
    expect(daemon.hostState().workers.map((worker) => worker.worker_id)).toEqual([`w-${driver}-1`]);

    await commandRedskilledWorker(daemonPaths, {
      command: "stop",
      worker_id: `w-${driver}-1`,
      session_project: "acme/widgets",
    });
    expect(stops).toBe(1);
    expect(daemon.hostState().workers).toEqual([]);

    const replacement = daemon.startWorker(spec(driver, `w-${driver}-2`));
    expect(replacement.plan.driver).toBe(driver);
    expect(births).toBe(2);

    alive.delete(`w-${driver}-2`);
    await daemon.sweepWorkerLiveness();
    expect(daemon.hostState().workers).toEqual([]);
  });
});
