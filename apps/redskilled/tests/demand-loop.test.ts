// The demand loop, inside the daemon (ADR 0130 Amendment 4). A registered
// project with a non-empty queue gets Workers born up to its target, and no
// process of the project's own is running while it happens.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  planHostDemand,
  REDSKILLED_DEMAND_BACKOFF_MS,
  type RedskilledDemandProject,
} from "../src/demand-loop.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import type { LaunchedWorker, LaunchWorkerOptions } from "../src/worker-launch.js";

const NOW_MS = Date.parse("2026-07-31T10:00:00.000Z");

function project(label: string, overrides: Partial<RedskilledDemandProject> = {}): RedskilledDemandProject {
  return {
    project_label: label,
    selector: `repo:${label} label:ready-for-agent`,
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: `/tmp/${label}`,
    target: 2,
    ...overrides,
  };
}

describe("planHostDemand — how many Workers each project may ask for", () => {
  it("asks for the target when the queue is deep enough and nothing is live", () => {
    const plan = planHostDemand({
      projects: [project("acme/widgets")],
      queue: { "acme/widgets": 9 },
      live: {},
      nowMs: NOW_MS,
    });

    expect(plan.births).toHaveLength(2);
    expect(plan.births.map((birth) => birth.index)).toEqual([0, 1]);
    expect(plan.births[0]!.argv).toEqual(["red-skills-dev", "run", "--once"]);
    expect(plan.births[0]!.workspace_path).toBe("/tmp/acme/widgets");
    expect(plan.intents[0]!.outcome).toBe("asking");
  });

  it("never asks for more Workers than the queue has items", () => {
    const plan = planHostDemand({
      projects: [project("acme/widgets", { target: 5 })],
      queue: { "acme/widgets": 1 },
      live: {},
      nowMs: NOW_MS,
    });

    expect(plan.births).toHaveLength(1);
    expect(plan.intents[0]!.wanted).toBe(1);
  });

  it("counts the Workers a project already holds against its target", () => {
    const plan = planHostDemand({
      projects: [project("acme/widgets", { target: 3 })],
      queue: { "acme/widgets": 8 },
      live: { "acme/widgets": 3 },
      nowMs: NOW_MS,
    });

    expect(plan.births).toEqual([]);
    expect(plan.intents[0]!.outcome).toBe("at-target");
  });

  it("asks for nothing when the queue has drained, and says so", () => {
    const plan = planHostDemand({
      projects: [project("acme/widgets")],
      queue: { "acme/widgets": 0 },
      live: {},
      nowMs: NOW_MS,
    });

    expect(plan.births).toEqual([]);
    expect(plan.intents[0]!.outcome).toBe("queue-drained");
  });

  it("treats an uncounted queue and an uncountable one as absent depth, never as zero", () => {
    const plan = planHostDemand({
      projects: [project("acme/counted"), project("acme/never")],
      queue: { "acme/counted": null },
      live: {},
      nowMs: NOW_MS,
    });

    expect(plan.births).toEqual([]);
    expect(plan.intents.map((intent) => intent.outcome)).toEqual(["queue-unknown", "queue-unknown"]);
    // Two different facts, told apart in the sentence a reader gets.
    expect(plan.intents[0]!.detail).not.toBe(plan.intents[1]!.detail);
  });

  it("holds every project back while the host's refusal backoff stands, then asks again", () => {
    const backoffUntilMs = NOW_MS + REDSKILLED_DEMAND_BACKOFF_MS;
    const held = planHostDemand({
      projects: [project("acme/widgets")],
      queue: { "acme/widgets": 4 },
      live: {},
      nowMs: NOW_MS,
      backoffUntilMs,
    });

    expect(held.births).toEqual([]);
    expect(held.intents[0]!.outcome).toBe("backing-off");

    const after = planHostDemand({
      projects: [project("acme/widgets")],
      queue: { "acme/widgets": 4 },
      live: {},
      nowMs: backoffUntilMs,
      backoffUntilMs,
    });
    expect(after.births).toHaveLength(2);
  });

  it("spreads births across projects one apiece before a second, so the first in line cannot take the host", () => {
    const plan = planHostDemand({
      projects: [project("acme/second", { target: 2 }), project("acme/first", { target: 2 })],
      queue: { "acme/first": 9, "acme/second": 9 },
      live: {},
      nowMs: NOW_MS,
    });

    expect(plan.births.map((birth) => `${birth.project_label}#${birth.index}`)).toEqual([
      "acme/first#0",
      "acme/second#0",
      "acme/first#1",
      "acme/second#1",
    ]);
  });

  it("reads nothing of what a selector or an argv says", () => {
    // Same depth, same target, wildly different strings: identical treatment is
    // the assertion — the loop carries these values and never reads them.
    const plan = planHostDemand({
      projects: [
        project("acme/plain"),
        project("acme/odd", {
          selector: "is:issue is:open label:ready-for-agent -label:blocked:dependency sort:created-asc",
          argv: ["/usr/bin/env", "--", "sh", "-c", "echo 'label:ready-for-agent'"],
        }),
      ],
      queue: { "acme/plain": 4, "acme/odd": 4 },
      live: {},
      nowMs: NOW_MS,
    });

    const perProject = plan.births.reduce<Record<string, number>>((counts, birth) => {
      counts[birth.project_label] = (counts[birth.project_label] ?? 0) + 1;
      return counts;
    }, {});
    expect(perProject).toEqual({ "acme/plain": 2, "acme/odd": 2 });
    expect(plan.intents.map((intent) => intent.outcome)).toEqual(["asking", "asking"]);
  });
});

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-demand-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A launch that births nothing: the loop is what is under test, not the spawn. */
function recordingLaunch(launched: LaunchWorkerOptions[]) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    if (!options.admission.admitted) throw new Error(options.admission.reason);
    launched.push(options);
    born += 1;
    const workerId = `w${born}`;
    return {
      worker: {
        worker_id: workerId,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        pid: 1_000 + born,
        started_at: "2026-07-31T10:00:00.000Z",
        isolated: false,
        warnings: [],
      },
      admission: options.admission,
      ...(options.forkSha == null ? {} : { fork_sha: options.forkSha }),
      warnings: [],
      plan: {
        backend: "none",
        command: options.spec.command,
        args: [...(options.spec.args ?? [])],
        isolated: false,
        warnings: [],
      } as unknown as LaunchedWorker["plan"],
      child: { pid: 1_000 + born, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
    };
  };
}

function registration(label: string, target: number, workspace: string) {
  return {
    project_label: label,
    selector: `repo:${label} label:ready-for-agent`,
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: workspace,
    target,
  };
}

describe("the daemon drives the demand loop itself", () => {
  it("refreshes one fork SHA for a burst and refuses an unreachable trunk before any Worker is born", async () => {
    const launched: LaunchWorkerOptions[] = [];
    const workspace = await scratch("redskilled-workspace-");
    let fetches = 0;
    let remoteReachable = true;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch(launched),
      refreshTrunk: async () => {
        fetches += 1;
        if (!remoteReachable) throw new Error("origin is unreachable");
        return "fork-sha-123";
      },
      queueDiscovery: { intervalMs: 0, transport: async () => answer([4]) },
    });
    running.push(daemon);

    daemon.registerProject({
      ...registration("acme/widgets", 3, workspace),
      trunk: { remote: "origin", branch: "main" },
    });
    await daemon.pollQueueDiscovery();
    const granted = await daemon.driveDemand();

    expect(fetches).toBe(1);
    expect(granted.granted.map((grant) => grant.fork_sha)).toEqual([
      "fork-sha-123",
      "fork-sha-123",
      "fork-sha-123",
    ]);
    expect(launched.map((birth) => birth.forkSha)).toEqual([
      "fork-sha-123",
      "fork-sha-123",
      "fork-sha-123",
    ]);

    daemon.releaseWorker("w1");
    daemon.releaseWorker("w2");
    daemon.releaseWorker("w3");
    remoteReachable = false;
    const refused = await daemon.driveDemand();
    expect(refused.granted).toEqual([]);
    expect(refused.refusal).toMatch(/refused-unreachable-trunk-remote/);
    expect(launched).toHaveLength(3);

    remoteReachable = true;
    const retried = await daemon.driveDemand();
    expect(retried.granted).toHaveLength(3);
    expect(fetches).toBe(3);
  });

  it("births Workers up to a registered project's target, with no process of the project's own", async () => {
    const launched: LaunchWorkerOptions[] = [];
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch(launched),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([4]) },
    });
    running.push(daemon);

    daemon.registerProject(registration("acme/widgets", 2, workspace));
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    expect(tick.requested).toBe(2);
    expect(tick.granted).toHaveLength(2);
    expect(tick.shortfall).toBe(0);
    expect(tick.refusal).toBeNull();
    expect(daemon.workerCount()).toBe(2);
    // The argv it was handed, run in the workspace it was handed. Nothing read.
    expect(launched[0]!.spec.command).toBe("red-skills-dev");
    expect(launched[0]!.spec.args).toEqual(["run", "--once"]);
    expect(launched[0]!.spec.workspace_path).toBe(workspace);
    expect(daemon.demand()).toEqual(tick);
  });

  it("stops at its target on the next tick instead of birthing a second wave", async () => {
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      // The recording launch births no process, so the host must be told these
      // are alive: the tick's own liveness sweep (#3123) would otherwise retire
      // the very Workers the second tick is meant to count.
      liveness: () => true,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([9]) },
    });
    running.push(daemon);

    daemon.registerProject(registration("acme/widgets", 2, workspace));
    await daemon.pollQueueDiscovery();
    await daemon.driveDemand();
    const second = await daemon.driveDemand();

    expect(second.requested).toBe(0);
    expect(second.projects[0]!.outcome).toBe("at-target");
    expect(daemon.workerCount()).toBe(2);
  });

  it("records a smaller grant as an ordinary outcome carrying the host's own reason", async () => {
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: { memory_bytes: null, worker_count: 1, source: "declared" },
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch([]),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([9]) },
    });
    running.push(daemon);

    daemon.registerProject(registration("acme/widgets", 3, workspace));
    await daemon.pollQueueDiscovery();
    // Resolves — a refusal is an answer the loop lives with, never a throw.
    const tick = await daemon.driveDemand();

    expect(tick.requested).toBe(3);
    expect(tick.granted).toHaveLength(1);
    expect(tick.shortfall).toBe(2);
    expect(tick.refusal).toMatch(/host ceiling of 1 Worker/);
    expect(tick.retry_after).not.toBeNull();
  });

  it("does not re-ask immediately after a refusal, so a full machine is not a busy loop", async () => {
    const launched: LaunchWorkerOptions[] = [];
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: { memory_bytes: null, worker_count: 1, source: "declared" },
      sampleMs: 0,
      demandMs: 0,
      launch: recordingLaunch(launched),
      queueDiscovery: { intervalMs: 0, transport: async () => answer([9]) },
    });
    running.push(daemon);

    daemon.registerProject(registration("acme/widgets", 3, workspace));
    await daemon.pollQueueDiscovery();
    await daemon.driveDemand();
    const attempts = launched.length;

    const second = await daemon.driveDemand();

    expect(launched).toHaveLength(attempts);
    expect(second.requested).toBe(0);
    expect(second.projects[0]!.outcome).toBe("backing-off");
    expect(second.refusal).toBeNull();
  });

  it("holds the daemon alive while a registration stands, so the loop outlives the session", async () => {
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      idleMs: 60_000,
    });
    running.push(daemon);

    expect(daemon.evaluateIdle()).toBe("exited");

    const held = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      idleMs: 60_000,
    });
    running.push(held);
    held.registerProject(registration("acme/widgets", 1, await scratch("redskilled-workspace-")));

    expect(held.evaluateIdle()).toBe("held-by-registrations");
  });
});

/** One aliased answer, in the shape the tracker gives it back. */
function answer(depths: readonly number[]): unknown {
  const data: Record<string, unknown> = { rateLimit: { remaining: 4_900, resetAt: null } };
  depths.forEach((depth, index) => {
    data[`q${index}`] = { issueCount: depth };
  });
  return { data };
}
