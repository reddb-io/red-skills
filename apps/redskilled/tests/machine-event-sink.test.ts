import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { LaunchedWorker, LaunchWorkerOptions, RedskilledWorkerSpec } from "../src/worker-launch.js";

const roots: string[] = [];
const daemons: RedskilledDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function recordingLaunch(launched: LaunchWorkerOptions[]) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    launched.push(options);
    born += 1;
    const workerId = options.spec.worker_id ?? `w${born}`;
    return {
      worker: {
        worker_id: workerId,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        pid: 8_000 + born,
        started_at: options.clock!(),
        isolated: false,
        warnings: [],
      },
      admission: options.admission,
      warnings: [],
      plan: { backend: "none", command: options.spec.command, args: [], isolated: false, warnings: [] } as unknown as LaunchedWorker["plan"],
      child: { pid: 8_000 + born, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
    };
  };
}

describe("operator-scoped daemon event sinks", () => {
  it("admits a configured hook and sends the triggering host-state document on stdin", async () => {
    const root = await scratch("redskilled-machine-hook-");
    const workspace = await scratch("redskilled-machine-hook-workspace-");
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({
      paths: resolveRedskilledPaths({
        env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
        runtimeDir: root,
      }),
      launch: recordingLaunch(launched),
      unitInventory: () => [],
      sampleMs: 0,
      hostEventSinks: {
        workspacePath: root,
        hooks: { "worker-birth": { argv: ["redwall", "refresh"] } },
      },
    });
    daemons.push(daemon);

    const source: RedskilledWorkerSpec = {
      worker_id: "source",
      project_label: "acme/widgets",
      workspace_path: workspace,
      command: "work",
    };
    daemon.startWorker(source);
    await daemon.flushEvents();

    expect(launched).toHaveLength(2);
    expect(launched[1]!.spec).toMatchObject({
      project_label: "redskilled/host-events",
      workspace_path: root,
      command: "redwall",
      args: ["refresh"],
    });
    expect(launched[1]!.admission.admitted).toBe(true);
    expect(JSON.parse(launched[1]!.spec.input!)).toMatchObject({
      version: 1,
      protocol_version: 1,
      workers: [{ worker_id: "source", project_label: "acme/widgets" }],
    });
  });

  it("surfaces the same event through the host's native desktop notifier", async () => {
    const root = await scratch("redskilled-machine-notification-");
    const workspace = await scratch("redskilled-machine-notification-workspace-");
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({
      paths: resolveRedskilledPaths({
        env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
        runtimeDir: root,
      }),
      launch: recordingLaunch(launched),
      unitInventory: () => [],
      sampleMs: 0,
      hostEventSinks: {
        workspacePath: root,
        notifications: ["worker-birth"],
        platform: "linux",
        commandAvailable: () => true,
      },
    });
    daemons.push(daemon);

    daemon.startWorker({
      worker_id: "source",
      project_label: "acme/widgets",
      workspace_path: workspace,
      command: "work",
    });
    await daemon.flushEvents();

    expect(launched).toHaveLength(2);
    expect(launched[1]!.spec).toMatchObject({
      project_label: "redskilled/host-events",
      command: "notify-send",
      args: ["redskilled", "Worker born: 1 active"],
      env: { REDSKILLED_HOST_EVENT: "worker-birth" },
    });
    expect(JSON.parse(launched[1]!.spec.input!)).toMatchObject({
      workers: [{ worker_id: "source" }],
    });
  });

  it("degrades once and permanently when the notification binary is absent (#4153)", async () => {
    const root = await scratch("redskilled-machine-notification-absent-");
    const workspace = await scratch("redskilled-machine-notification-absent-workspace-");
    const launched: LaunchWorkerOptions[] = [];
    const daemon = await startRedskilledDaemon({
      paths: resolveRedskilledPaths({
        env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
        runtimeDir: root,
      }),
      launch: recordingLaunch(launched),
      unitInventory: () => [],
      sampleMs: 0,
      hostEventSinks: {
        workspacePath: root,
        notifications: ["worker-birth"],
        platform: "linux",
        commandAvailable: () => false,
      },
    });
    daemons.push(daemon);

    daemon.startWorker({
      worker_id: "source-a",
      project_label: "acme/widgets",
      workspace_path: workspace,
      command: "work",
    });
    daemon.startWorker({
      worker_id: "source-b",
      project_label: "acme/widgets",
      workspace_path: workspace,
      command: "work",
    });
    await daemon.flushEvents();

    // Two eligible events, ZERO sink Workers: an absent optional binary is a
    // one-line degradation, never a crash-looping birth in the breaker.
    expect(launched.map((launch) => launch.spec.project_label)).toEqual(["acme/widgets", "acme/widgets"]);
  });
});
