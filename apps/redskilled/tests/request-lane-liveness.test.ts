// A tracker call may outlive a whole operator session. It must never become the
// daemon's request lane: socket reads, writes, dispatch, and stop are all local
// operations and remain answerable while the poller is parked behind GitHub.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  publishRedskilledWorkerLogLine,
  readRedskilledHostState,
  registerRedskilledProject,
  startRedskilledWorker,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import type { RedskilledActivityTransport } from "../src/repository-activity.js";
import { REDSKILLED_WORKER_DISPLAY_ABSENT } from "../src/worker-display.js";
import type { LaunchedWorker, LaunchWorkerOptions } from "../src/worker-launch.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function localLaunch(options: LaunchWorkerOptions): LaunchedWorker {
  const worker = {
    worker_id: options.spec.worker_id ?? "wLOCAL",
    project_label: options.spec.project_label,
    workspace_path: options.spec.workspace_path,
    pid: 7_674,
    started_at: options.clock!(),
    isolated: false,
    warnings: [],
  };
  return {
    worker,
    admission: options.admission,
    warnings: [],
    plan: {
      backend: "none",
      command: options.spec.command,
      args: [...(options.spec.args ?? [])],
      isolated: false,
      warnings: [],
    } as unknown as LaunchedWorker["plan"],
    child: { pid: worker.pid, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
  };
}

describe("the daemon request lane during a stalled GitHub poll", () => {
  it("reports consecutive self-ping misses on host state", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-self-ping-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      selfPingIntervalMs: 5,
      selfPingTimeoutMs: 2,
      selfPingMissThreshold: 2,
      selfPing: async () => await new Promise<never>(() => undefined),
    });
    running.push(daemon);

    await new Promise((resolve) => setTimeout(resolve, 30));
    const health = (daemon.hostState() as unknown as Record<string, unknown>).request_health;
    expect(health).toMatchObject({
      status: "degraded",
      consecutive_misses: expect.any(Number),
      miss_threshold: 2,
    });
  });

  it("keeps local requests and metrics live, and releases the poller at its deadline", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-request-lane-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const never = new Promise<unknown>(() => undefined);
    const transport = (() => never) as RedskilledActivityTransport;
    let minute = 0;
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      demandMs: 0,
      launch: localLaunch,
      clock: () => new Date(Date.parse("2026-08-11T20:00:00.000Z") + minute * 60_000).toISOString(),
      queueDiscovery: { transport, intervalMs: 0 },
      githubBalance: { transport: () => never },
      remotePollTimeoutMs: 25,
    });
    running.push(daemon);

    await registerRedskilledProject(paths, {
      project_label: "acme/widgets",
      selector: "repo:acme/widgets is:issue is:open label:ready-for-agent",
      queue_poll: { owner: "acme", repo: "widgets", labels: ["ready-for-agent"] },
      argv: ["work"],
      workspace_path: root,
      target: 1,
    }, { requestTimeoutMs: 150 });

    const stalledPoll = daemon.pollQueueDiscovery().then(
      () => "completed",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    const stalledActivity = daemon.pollRepositoryActivity().then(
      () => "completed",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    const stalledBalance = daemon.pollGithubBalance().then(
      () => "completed",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );

    const ping = await sendRedskilledRequest(
      { socketPath: paths.socketPath, timeoutMs: 150 },
      { id: "ping-under-stall", op: "ping" },
    );
    expect(ping.ok).toBe(true);

    const started = await startRedskilledWorker(paths, {
      worker_id: "wLOCAL",
      project_label: "acme/widgets",
      workspace_path: root,
      command: "work",
    }, { requestTimeoutMs: 150 });
    await publishRedskilledWorkerLogLine(paths, {
      worker_id: started.worker.worker_id,
      session_project: "acme/widgets",
      line: "still working",
      display: { ...REDSKILLED_WORKER_DISPLAY_ABSENT, tokens: 120, tools: 3 },
    }, { requestTimeoutMs: 150 });
    minute = 1;
    await publishRedskilledWorkerLogLine(paths, {
      worker_id: started.worker.worker_id,
      session_project: "acme/widgets",
      line: "still working",
      display: { ...REDSKILLED_WORKER_DISPLAY_ABSENT, tokens: 240, tools: 5 },
    }, { requestTimeoutMs: 150 });

    const state = await readRedskilledHostState(paths, { requestTimeoutMs: 150 });
    expect(state.workers.map((worker) => worker.worker_id)).toContain("wLOCAL");
    expect(daemon.statuslinePayload().metrics?.hour.tokens_per_min.value).not.toBeNull();

    for (const poll of [stalledPoll, stalledActivity, stalledBalance]) {
      const pollOutcome = await Promise.race([
        poll,
        new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 100)),
      ]);
      expect(pollOutcome).toContain("deadline");
    }

    const shutdown = await sendRedskilledRequest(
      { socketPath: paths.socketPath, timeoutMs: 150 },
      { id: "shutdown-under-stall", op: "shutdown" },
    );
    expect(shutdown.ok).toBe(true);
  });
});
