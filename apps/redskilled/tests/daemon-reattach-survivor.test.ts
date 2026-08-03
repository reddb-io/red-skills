// The Worker survives the daemon; the daemon must survive the Worker's launcher.
//
// Observed on 2026-07-31 (issue #2917): daemon 3.0.1 was replaced, its Worker's
// transient unit stayed `active` with its own MainPID, and the successor reported
// `workers: []`. The lane said why — a `worker-death` written for the Worker at
// the instant its `systemd-run --wait` LAUNCH CLIENT was killed, while the unit
// it was standing beside kept running. A death on the lane is forever: every
// successor replays it, adopts nothing, and the live Worker spends memory the
// arbiter no longer counts.
//
// So these checks pin three things the in-process restart suite could not see:
//
//   1. the exit of a launch client whose unit is still active is NOT a death —
//      neither in the daemon's Worker set nor on its lane (the failing fixture);
//   2. re-attachment holds against a REAL predecessor/successor pair — two
//      daemon processes, the first killed rather than asked to stop;
//   3. a Worker no lane accounts for is adopted and named, never left invisible.
import { spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureRedskilledDaemon,
  readRedskilledHostState,
  startRedskilledWorker,
  type RedskilledClientConfig,
} from "../src/client.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane, readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import { REDSKILLED_UNOWNED_PROJECT_LABEL } from "../src/reattach.js";
import type { LaunchWorkerOptions, LaunchedWorker, RedskilledWorkerSpec } from "../src/worker-launch.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const sockets: string[] = [];
const spawnedPids: number[] = [];
/** Real transient units this test asked for, stopped by name — killing a pid would not. */
const spawnedUnits: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const socketPath of sockets.splice(0)) {
    await sendRedskilledRequest({ socketPath }, { id: `shutdown-${socketPath.length}`, op: "shutdown" }).catch(
      () => undefined,
    );
  }
  for (const unit of spawnedUnits.splice(0)) {
    spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore" });
  }
  for (const pid of spawnedPids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-survivor-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** Liveness by pid: the host under test may have no systemd --user session. */
function pidLiveness(worker: RedskilledWorkerView): boolean {
  try {
    process.kill(worker.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A birth whose launch client and Worker are two different things.
 *
 * Exactly the transient-unit shape, without needing systemd: the daemon is handed
 * a Worker carrying a unit name, and `exitLaunchClient` fires the exit the daemon
 * would observe when the client — never the unit — is killed.
 */
function unitBackedLaunch(state: { exitLaunchClient?: (signal: NodeJS.Signals) => void }) {
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    const workerId = options.spec.worker_id ?? "w-unit";
    const worker: RedskilledWorkerView = {
      worker_id: workerId,
      project_label: options.spec.project_label,
      pid: 4_242,
      started_at: "2026-07-31T01:18:56.987Z",
      workspace_path: options.spec.workspace_path,
      isolated: true,
      unit: `red-worker-acme-widgets-${workerId}.service`,
      ...(options.spec.budget != null ? { budget: options.spec.budget } : {}),
      warnings: [],
    };
    state.exitLaunchClient = (signal: NodeJS.Signals) => options.onExit?.(workerId, null, signal);
    return {
      worker,
      admission: options.admission,
      warnings: [],
      plan: {
        isolated: true,
        backend: "transient-unit",
        command: "systemd-run",
        args: [],
        unit: worker.unit!,
        budget: options.spec.budget ?? {},
        environment: {},
      },
      child: { pid: worker.pid } as ChildProcess,
    };
  };
}

function spec(overrides: Partial<RedskilledWorkerSpec> = {}): RedskilledWorkerSpec {
  return {
    project_label: "acme/widgets",
    workspace_path: "/tmp/workspace",
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30000);"],
    budget: { memory_high: "512M", memory_max: "1G", cpu_weight: 100 },
    ...overrides,
  };
}

describe("a launch client that dies is not a Worker that died", () => {
  it("keeps holding the Worker, and writes no death, while its unit stays active", async () => {
    const paths = await sessionPaths();
    const launcher: { exitLaunchClient?: (signal: NodeJS.Signals) => void } = {};
    // The unit is active throughout; only the process beside it is killed.
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      launch: unitBackedLaunch(launcher),
      liveness: (worker) => worker.unit != null,
      unitInventory: () => [],
      unitMainPid: () => 137_873,
    });
    running.push(daemon);

    const started = daemon.startWorker(spec({ worker_id: "wWTVC" }));
    expect(started.worker.unit).toBe("red-worker-acme-widgets-wWTVC.service");

    launcher.exitLaunchClient!("SIGKILL");
    await daemon.flushEvents();

    // The Worker is still held, still labelled, still budgeted...
    expect(daemon.workerCount()).toBe(1);
    const state = daemon.hostState();
    expect(state.workers.map((worker) => worker.worker_id)).toEqual(["wWTVC"]);
    expect(state.workers[0]!.project_label).toBe("acme/widgets");
    expect(state.budget_accounting.worker_count).toBe(1);
    expect(state.budget_accounting.memory_high_bytes).toBe(512 * 1024 * 1024);
    // ...and the daemon says out loud that it now holds it by unit name.
    expect(state.workers[0]!.warnings.join(" ")).toMatch(/launch client ended .* stayed active/);
    // The pid it watches is the unit's own, not the client's spent number.
    expect(state.workers[0]!.pid).toBe(137_873);

    // The lane is what a successor replays, so the absence of a death IS the fix.
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.event)).toEqual(["worker-birth"]);
  });

  it("lets a successor adopt that Worker, instead of replaying a death it never died", async () => {
    const paths = await sessionPaths();
    const launcher: { exitLaunchClient?: (signal: NodeJS.Signals) => void } = {};
    const first = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      launch: unitBackedLaunch(launcher),
      liveness: (worker) => worker.unit != null,
      unitInventory: () => [],
      unitMainPid: () => 137_873,
    });
    running.push(first);
    first.startWorker(spec({ worker_id: "wWTVC" }));
    launcher.exitLaunchClient!("SIGKILL");
    await first.flushEvents();
    await first.stop();

    const second = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      liveness: (worker) => worker.unit != null,
      unitInventory: () => [],
      unitMainPid: () => 137_873,
    });
    running.push(second);

    expect(second.hostState().workers.map((worker) => worker.worker_id)).toEqual(["wWTVC"]);
    expect(second.reattached().map((worker) => worker.worker_id)).toEqual(["wWTVC"]);
    expect(second.hostState().budget_accounting.worker_count).toBe(1);
  });

  it("still records a death when the process that exited WAS the Worker", async () => {
    const paths = await sessionPaths();
    const launcher: { exitLaunchClient?: (signal: NodeJS.Signals) => void } = {};
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      // An unisolated Worker: no unit, so nothing stands between the daemon and it.
      launch: (options) => {
        const launched = unitBackedLaunch(launcher)(options);
        const { unit: _unit, ...worker } = launched.worker;
        return { ...launched, worker: { ...worker, isolated: false } };
      },
      liveness: () => true,
      unitInventory: () => [],
    });
    running.push(daemon);

    daemon.startWorker(spec({ worker_id: "w-loose" }));
    launcher.exitLaunchClient!("SIGKILL");
    await daemon.flushEvents();

    expect(daemon.workerCount()).toBe(0);
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.event)).toEqual(["worker-birth", "worker-death"]);
    expect(events[1]!.signal).toBe("SIGKILL");
  });
});

describe("a Worker the lane cannot attribute", () => {
  it("is adopted from its active unit and named, never left invisible", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      liveness: () => true,
      // The host is running a Worker whose birth nobody wrote — the residue the
      // false death left behind on the machine that reported this bug.
      unitInventory: () => ["red-worker-reddb-io-red-skills-wwtvc.service"],
      unitMainPid: () => 137_873,
    });
    running.push(daemon);
    await daemon.flushEvents();

    const state = daemon.hostState();
    expect(state.workers).toHaveLength(1);
    expect(state.workers[0]!.unit).toBe("red-worker-reddb-io-red-skills-wwtvc.service");
    expect(state.workers[0]!.pid).toBe(137_873);
    expect(state.workers[0]!.project_label).toBe(REDSKILLED_UNOWNED_PROJECT_LABEL);
    expect(state.workers[0]!.warnings.join(" ")).toMatch(/no birth on this host's event lane/);
    // Counted, which is the entire point: an unheld Worker is room the next
    // admission believes the machine has and it does not.
    expect(state.budget_accounting.worker_count).toBe(1);

    // And the adoption is on the lane, so the NEXT daemon inherits it as a birth.
    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.event)).toEqual(["worker-birth"]);
    expect(events[0]!.detail).toMatch(/no birth on this lane/);
  });

  it("is not adopted twice when the lane already holds it", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({
      event: "worker-birth",
      ts: "2026-07-31T01:18:56.987Z",
      worker: {
        worker_id: "wWTVC",
        project_label: "reddb-io/red-skills",
        pid: 137_871,
        started_at: "2026-07-31T01:18:56.987Z",
        workspace_path: "/tmp/ws",
        isolated: true,
        unit: "red-worker-reddb-io-red-skills-wwtvc.service",
        warnings: [],
      },
    });

    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      liveness: () => true,
      unitInventory: () => ["red-worker-reddb-io-red-skills-wwtvc.service"],
      unitMainPid: () => 137_873,
    });
    running.push(daemon);

    const state = daemon.hostState();
    expect(state.workers.map((worker) => worker.worker_id)).toEqual(["wWTVC"]);
    expect(state.workers[0]!.project_label).toBe("reddb-io/red-skills");
    // The lane's pid was the launch client's and is spent; the unit's is watched.
    expect(state.workers[0]!.pid).toBe(137_873);
  });

  it("keeps a Worker whose owning project the lane no longer carries, under a stated label", async () => {
    const paths = await sessionPaths();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    await lane.record({
      event: "worker-birth",
      ts: "2026-07-31T01:18:56.987Z",
      worker: {
        worker_id: "w-orphan",
        project_label: "",
        pid: process.pid,
        started_at: "2026-07-31T01:18:56.987Z",
        workspace_path: "/tmp/ws",
        isolated: false,
        warnings: [],
      },
    });

    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      liveness: () => true,
      unitInventory: () => [],
    });
    running.push(daemon);

    const state = daemon.hostState();
    expect(state.workers.map((worker) => worker.worker_id)).toEqual(["w-orphan"]);
    expect(state.workers[0]!.project_label).toBe(REDSKILLED_UNOWNED_PROJECT_LABEL);
    expect(state.workers[0]!.warnings.join(" ")).toMatch(/no owning project on the event lane/);
    expect(state.projects).toEqual([{ project_label: REDSKILLED_UNOWNED_PROJECT_LABEL, worker_count: 1 }]);
    expect(state.budget_accounting.worker_count).toBe(1);
  });
});

describe("a real predecessor and a real successor", () => {
  it("hands a live Worker from one daemon process to the next, with its identity and budget", async () => {
    const root = await scratch("redskilled-pair-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const config: RedskilledClientConfig = {
      serverCommand: process.execPath,
      serverArgs: ["--import", tsxLoader, cliEntry],
      readyTimeoutMs: 30_000,
      idleMs: 120_000,
      env: {
        ...process.env,
        REDSKILLED_SESSION: `test:${root}`,
        REDSKILLED_MACHINE_DIR: root,
        // This machine may already run the real daemon; the successor under test
        // must sweep its own session's units and never adopt the host's Workers.
        REDSKILLED_UNIT_DISCOVERY: "off",
      },
    };

    expect(await ensureRedskilledDaemon(paths, config)).toBe("spawned");
    sockets.push(paths.socketPath);
    const predecessor = await readRedskilledHostState(paths, config);

    const started = await startRedskilledWorker(
      paths,
      {
        worker_id: "wPAIR",
        project_label: "acme/widgets",
        workspace_path: root,
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 120000);"],
        budget: { memory_high: "512M", memory_max: "1G", cpu_weight: 100 },
        // A prefix of this test's own, so a unit it leaves behind is never mistaken
        // for one of this machine's real Workers.
        placement: { isolation: "transient-unit", unit_prefix: "red-test-worker" },
      },
      config,
    );
    spawnedPids.push(started.worker.pid);
    if (started.worker.unit != null) spawnedUnits.push(started.worker.unit);
    expect((await readRedskilledHostState(paths, config)).workers).toHaveLength(1);

    // Replace the daemon the way an operator does: signal it, do not ask it.
    process.kill(predecessor.pid, "SIGTERM");
    await waitFor(async () => !(await socketAnswers(paths.socketPath)), 15_000, "the predecessor did not exit");

    // The Worker outlived it — the half of the contract that already worked.
    expect(pidLiveness(started.worker), "the Worker did not survive its daemon").toBe(true);

    expect(await ensureRedskilledDaemon(paths, config)).toBe("spawned");
    const successor = await readRedskilledHostState(paths, config);
    expect(successor.pid).not.toBe(predecessor.pid);

    // The half that did not: the successor holds it, with everything it was born with.
    expect(successor.workers.map((worker) => worker.worker_id)).toEqual(["wPAIR"]);
    expect(successor.workers[0]!.project_label).toBe("acme/widgets");
    expect(successor.workers[0]!.workspace_path).toBe(root);
    expect(successor.workers[0]!.unit).toBe(started.worker.unit);
    expect(successor.projects).toEqual([{ project_label: "acme/widgets", worker_count: 1 }]);
    // Adopted means counted, from the moment it is adopted.
    expect(successor.budget_accounting.worker_count).toBe(1);
    expect(successor.budget_accounting.memory_high_bytes).toBe(512 * 1024 * 1024);
    expect(successor.budget_accounting.memory_max_bytes).toBe(1024 * 1024 * 1024);
    expect(successor.budget_accounting.cpu_weight_total).toBe(100);
  }, 120_000);
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs: number, complaint: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(complaint);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
