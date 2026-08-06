// A registration-lane Worker's output reaches a surface, or it reaches none (#3079).
//
// Before this file the AFK lane was the one birth lane that declared nothing
// about where its Worker logs. `log_path` had been one of the four launch facts
// since Amendment 5, but only the direct `worker-start` lane could state it — a
// project that registers hands over a template and is never asked again — so
// every registration-lane Worker arrived at the herdr plugin, the VS Code
// extension and the verbose statusline carrying no path, and each of them
// reported the absence as a Worker with nothing to say.
//
// Two properties, and they are the same property at two ends: the template can
// SAY where the log goes, and the daemon's own birth is what WRITES the fact in.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseRecords } from "@reddb-io/toon";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { expandLaunchTemplate, requireLaunchLogPath, workerSpecFromLaunch } from "../src/launch-template.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import type { LaunchedWorker, LaunchWorkerOptions } from "../src/worker-launch.js";

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
  const root = await scratch("redskilled-logpath-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A launch that births nothing and answers with the id it was HANDED. */
function recordingLaunch(launched: LaunchWorkerOptions[]) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    if (!options.admission.admitted) throw new Error(options.admission.reason);
    launched.push(options);
    born += 1;
    const workerId = options.spec.worker_id ?? `w${born}`;
    return {
      worker: {
        worker_id: workerId,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        ...(options.spec.log_path == null ? {} : { log_path: options.spec.log_path }),
        pid: 1_000 + born,
        started_at: "2026-08-02T10:00:00.000Z",
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
      child: { pid: 1_000 + born, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
    };
  };
}

/** Poll a real child's evidence into existence, or fail with a stated deadline. */
async function until<T>(probe: () => Promise<T | null>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const answered = await probe();
    if (answered != null) return answered;
    if (Date.now() > deadline) throw new Error(`nothing was written inside ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function answer(depths: readonly number[]): unknown {
  const data: Record<string, unknown> = { rateLimit: { remaining: 4_900, resetAt: null } };
  depths.forEach((depth, index) => {
    data[`q${index}`] = { issueCount: depth };
  });
  return { data };
}

function registration(label: string, workspace: string, logPath?: string) {
  return {
    project_label: label,
    selector: `repo:${label} label:ready-for-agent`,
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: workspace,
    target: 1,
    ...(logPath == null ? {} : { log_path: logPath }),
  };
}

describe("a launch template states where its Worker logs", () => {
  it("expands the per-birth facts into the log path, exactly as it does the argv", () => {
    const expanded = expandLaunchTemplate(
      { argv: ["/bin/run"], log_path: "{{workspace_path}}/.red/tmp/workers/{{worker_id}}/worker.log.toonl" },
      { worker_id: "wAAAA", slot: 3, workspace_path: "/repo" },
    );

    expect(expanded.log_path).toBe("/repo/.red/tmp/workers/wAAAA/worker.log.toonl");
  });

  it("gives two Workers of one project two files, because one template serves both", () => {
    const template = { argv: ["/bin/run"], log_path: "/logs/worker-{{worker_id}}.log" };
    const first = workerSpecFromLaunch(template, { worker_id: "wAAAA", slot: 0, workspace_path: "/repo" }, {
      project_label: "acme/widgets",
    });
    const second = workerSpecFromLaunch(template, { worker_id: "wBBBB", slot: 1, workspace_path: "/repo" }, {
      project_label: "acme/widgets",
    });

    expect(first.log_path).toBe("/logs/worker-wAAAA.log");
    expect(second.log_path).toBe("/logs/worker-wBBBB.log");
  });

  it("lets the template overrule the fact, because only one of them was stated by the project", () => {
    const spec = workerSpecFromLaunch({ argv: ["/bin/run"], log_path: "/stated/{{worker_id}}.log" }, {
      worker_id: "wAAAA",
      slot: 0,
      workspace_path: "/repo",
      log_path: "/defaulted.log",
    }, { project_label: "acme/widgets" });

    expect(spec.log_path).toBe("/stated/wAAAA.log");
  });

  it("refuses a path stated as an empty string, because that is a declaration nobody finished", () => {
    expect(() => requireLaunchLogPath("   ", "acme/widgets")).toThrow(/non-empty string/);
    // Absence stays legal: the heartbeat needs no path, and a project may keep
    // the whole mechanism on the beat.
    expect(requireLaunchLogPath(undefined, "acme/widgets")).toBeUndefined();
  });
});

describe("the daemon writes its own facts into a registration's log path", () => {
  it("births a registration-lane Worker with the path expanded and its own id in it", async () => {
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

    daemon.registerProject(
      registration("acme/widgets", workspace, `${workspace}/.red/tmp/workers/{{worker_id}}/worker.log.toonl`),
    );
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    expect(tick.granted).toHaveLength(1);
    const spec = launched[0]!.spec;
    const workerId = tick.granted[0]!.worker_id;
    expect(workerId).toMatch(/^h[A-Z0-9]{4}$/);
    expect(spec.log_path).toBe(`${workspace}/.red/tmp/workers/${workerId}/worker.log.toonl`);
    // The record the surfaces read carries it too — the whole point of stating it.
    expect(daemon.hostState().workers[0]!.log_path).toBe(spec.log_path);
    expect(tick.granted[0]!.warnings).toEqual([]);
  });

  it("hands the registration's env to the Worker, with the birth's facts written in", async () => {
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

    daemon.registerProject({
      ...registration("acme/widgets", workspace),
      env: { REDSKILLED_WORKER_ID: "{{worker_id}}" },
    });
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    expect(launched[0]!.spec.env).toEqual({ REDSKILLED_WORKER_ID: tick.granted[0]!.worker_id });
  });

  it("opens the declared file and puts the Worker's own output in it", async () => {
    const workspace = await scratch("redskilled-workspace-");
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      queueDiscovery: { intervalMs: 0, transport: async () => answer([4]) },
    });
    running.push(daemon);

    daemon.registerProject({
      project_label: "acme/widgets",
      selector: "repo:acme/widgets label:ready-for-agent",
      // A real child, saying one real thing.
      argv: [process.execPath, "-e", "process.stdout.write('worker.claimed #3079\\n');"],
      workspace_path: workspace,
      log_path: `${workspace}/logs/worker-{{worker_id}}.log`,
      target: 1,
    });
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();
    const logPath = `${workspace}/logs/worker-${tick.granted[0]!.worker_id}.log`;

    // The daemon holds the descriptor open across the spawn, so the bytes land
    // whether or not the child has ended when we look.
    const written = await until(async () => {
      const text = await readFile(logPath, "utf8").catch(() => "");
      return text.includes("worker.claimed") ? text : null;
    });
    expect(written).toContain("worker.claimed #3079");
    expect(parseRecords(written)).toEqual([
      expect.objectContaining({ kind: "worker.stdout", msg: "worker.claimed #3079" }),
    ]);

    // And the surfaces read the path off the event lane, which is where the
    // herdr plugin and the VS Code extension both look for it.
    const events = await readRedskilledEvents(paths.eventLanePath);
    const birth = events.find((event) => event.event === "worker-birth");
    expect(birth?.log_path).toBe(logPath);
  });

  it("says so, once, when a project declared no log path at all", async () => {
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

    daemon.registerProject(registration("acme/widgets", workspace));
    await daemon.pollQueueDiscovery();
    const tick = await daemon.driveDemand();

    expect(launched[0]!.spec.log_path).toBeUndefined();
    expect(tick.granted[0]!.warnings.join(" ")).toContain("declared no log path");
  });
});
