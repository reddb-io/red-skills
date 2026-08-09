import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { RedskilledProjectRegistrationRequest } from "../src/project-registration.js";
import type { LaunchedWorker, LaunchWorkerOptions, RedskilledWorkerSpec } from "../src/worker-launch.js";

const PROJECT = "acme/widgets";
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

function recordingLaunch(launched: LaunchWorkerOptions[], hookExitCode?: number) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    if (!options.admission.admitted) throw new Error(options.admission.reason);
    launched.push(options);
    born += 1;
    const workerId = `w${born}`;
    if (options.spec.command === "notify" && hookExitCode != null) {
      queueMicrotask(() => options.onExit?.(workerId, hookExitCode, null));
    }
    return {
      worker: {
        worker_id: workerId,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        pid: 7_000 + born,
        started_at: options.clock!(),
        isolated: false,
        warnings: [],
      },
      admission: options.admission,
      warnings: [],
      plan: {
        backend: "none",
        command: options.spec.command,
        args: [...(options.spec.args ?? [])],
        isolated: false,
        warnings: [],
      } as unknown as LaunchedWorker["plan"],
      child: { pid: 7_000 + born, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
    };
  };
}

function registration(workspace: string, hookArgv: readonly string[]): RedskilledProjectRegistrationRequest {
  return {
    project_label: PROJECT,
    selector: "is:open label:ready-for-agent",
    argv: ["work"],
    workspace_path: workspace,
    target: 1,
    hooks: { "worker-birth": { argv: hookArgv, env: { SOURCE: "{{worker_id}}" } } },
  };
}

function source(workspace: string): RedskilledWorkerSpec {
  return { worker_id: "source", project_label: PROJECT, workspace_path: workspace, command: "work" };
}

describe("a project-scoped daemon hook", () => {
  it("is admitted, charged to its project, expanded, and recorded as another birth", async () => {
    const root = await scratch("redskilled-project-hook-");
    const workspace = await scratch("redskilled-project-hook-workspace-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({ paths, launch: recordingLaunch(launched), sampleMs: 0 });
    running.push(daemon);
    daemon.registerProject(registration(workspace, ["notify", "{{worker_id}}", "{{workspace_path}}"]));

    daemon.startWorker(source(workspace));
    await daemon.flushEvents();

    expect(launched).toHaveLength(2);
    const hookWorkerId = launched[1]!.spec.worker_id!;
    expect(launched[1]!.spec).toMatchObject({
      project_label: PROJECT,
      workspace_path: workspace,
      command: "notify",
      args: [hookWorkerId, workspace],
      env: { SOURCE: hookWorkerId },
    });
    expect(launched[1]!.admission).toMatchObject({
      admitted: true,
      consumption: { worker_count: 1 },
      projected_worker_count: 2,
    });
    const births = (await readRedskilledEvents(paths.eventLanePath)).filter((event) => event.kind === "worker-birth");
    expect(births.map((event) => [event.worker_id, event.project_label])).toEqual([
      ["w1", PROJECT],
      ["w2", PROJECT],
    ]);
  });

  it("refuses an unknown placeholder before launching the hook and names it on the lane", async () => {
    const root = await scratch("redskilled-project-hook-");
    const workspace = await scratch("redskilled-project-hook-workspace-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({ paths, launch: recordingLaunch(launched), sampleMs: 0 });
    running.push(daemon);
    daemon.registerProject(registration(workspace, ["notify", "{{mystery}}"]));

    expect(() => daemon.startWorker(source(workspace))).not.toThrow();
    await daemon.flushEvents();

    expect(launched).toHaveLength(1);
    const refusal = (await readRedskilledEvents(paths.eventLanePath)).find((event) => event.kind === "demand-refusal");
    expect(refusal?.detail).toContain("{{mystery}}");
  });

  it("records the host's own no-headroom reason without changing the triggering Worker", async () => {
    const root = await scratch("redskilled-project-hook-");
    const workspace = await scratch("redskilled-project-hook-workspace-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      launch: recordingLaunch(launched),
      ceiling: { memory_bytes: null, worker_count: 1, source: "declared" },
      sampleMs: 0,
    });
    running.push(daemon);
    daemon.registerProject(registration(workspace, ["notify"]));

    const worker = daemon.startWorker(source(workspace)).worker;
    await daemon.flushEvents();

    expect(worker.worker_id).toBe("w1");
    expect(daemon.hostState().workers.map((held) => held.worker_id)).toEqual(["w1"]);
    expect(launched).toHaveLength(1);
    const refusal = (await readRedskilledEvents(paths.eventLanePath)).find((event) => event.kind === "demand-refusal");
    expect(refusal?.detail).toContain("host ceiling of 1 Worker");
  });

  it("does not let an async hook exit change the triggering Worker or recurse", async () => {
    const root = await scratch("redskilled-project-hook-");
    const workspace = await scratch("redskilled-project-hook-workspace-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({ paths, launch: recordingLaunch(launched, 17), sampleMs: 0 });
    running.push(daemon);
    daemon.registerProject(registration(workspace, ["notify"]));

    const worker = daemon.startWorker(source(workspace)).worker;
    await new Promise((resolve) => setImmediate(resolve));
    await daemon.flushEvents();

    expect(worker.worker_id).toBe("w1");
    expect(daemon.hostState().workers.map((held) => held.worker_id)).toEqual(["w1"]);
    expect(launched).toHaveLength(2);
    expect((await readRedskilledEvents(paths.eventLanePath)).map((event) => event.kind)).toEqual([
      "worker-birth",
      "worker-birth",
      "worker-death",
    ]);
  });

  it("expires a sync hook onto the lane and releases another project's Worker birth", async () => {
    const root = await scratch("redskilled-project-hook-");
    const workspace = await scratch("redskilled-project-hook-workspace-");
    const otherWorkspace = await scratch("redskilled-project-hook-other-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({ paths, launch: recordingLaunch(launched), sampleMs: 0 });
    running.push(daemon);
    daemon.registerProject({
      ...registration(workspace, ["notify"]),
      hooks: {
        "worker-birth": { argv: ["notify"], mode: "sync", deadline_ms: 20 },
      },
    });

    const startedAt = Date.now();
    daemon.startWorker(source(workspace));
    await daemon.flushEvents();
    daemon.startWorker({
      worker_id: "other-source",
      project_label: "acme/gadgets",
      workspace_path: otherWorkspace,
      command: "work",
    });
    await daemon.flushEvents();

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(launched.map((entry) => entry.spec.project_label)).toEqual([
      PROJECT,
      PROJECT,
      "acme/gadgets",
    ]);
    const expiry = (await readRedskilledEvents(paths.eventLanePath)).find(
      (event) => event.kind === "demand-refusal" && event.project_label === PROJECT,
    );
    expect(expiry?.detail).toContain("sync worker-birth hook exceeded its declared 20ms deadline");
    expect(expiry?.detail).toContain("stopped waiting and proceeded");
  });

  it("leaves an unregistered project byte-for-byte on the existing event path", async () => {
    const root = await scratch("redskilled-project-hook-");
    const workspace = await scratch("redskilled-project-hook-workspace-");
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({ paths, launch: recordingLaunch(launched), sampleMs: 0 });
    running.push(daemon);

    daemon.startWorker(source(workspace));
    await daemon.flushEvents();

    expect(launched).toHaveLength(1);
    expect((await readRedskilledEvents(paths.eventLanePath)).map((event) => event.kind)).toEqual(["worker-birth"]);
  });
});
