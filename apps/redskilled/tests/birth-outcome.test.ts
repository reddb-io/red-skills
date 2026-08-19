// A clean "NO MORE TASKS" exit is not a loss (issue #4048). On 2026-08-19 the
// queue emptied while four Tickets were quarantined; the Workers already running
// found nothing to do, printed the sentinel and exited 0 seconds after birth.
// The daemon read three fast exits as three losses, refused every further demand
// for the project, and the latch had to be cleared by hand — so when the queue
// was repaired, nothing was born to consume it.
//
// The breaker's original job is intact and tested here beside it: a Worker that
// ends without reaching any terminal outcome still counts, and three of those
// still open the latch.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { REDSKILLED_SHORT_LIFE_STREAK } from "../src/demand-loop.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { LaunchedWorker, LaunchWorkerOptions } from "../src/worker-launch.js";

const START_MS = Date.parse("2026-08-19T06:29:23.000Z");
const PROJECT = "reddb-io/red-skills";
const NO_MORE_TASKS = "<promise>NO MORE TASKS</promise>";

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

/** A launch that hands back the daemon's own exit callback, so a test can end a Worker the way the OS does. */
function exitableLaunch(exits: Map<string, LaunchWorkerOptions["onExit"]>) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    if (!options.admission.admitted) throw new Error(options.admission.reason);
    born += 1;
    const workerId = `w${born}`;
    exits.set(workerId, options.onExit);
    return {
      worker: {
        worker_id: workerId,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        log_path: join(options.spec.workspace_path, "worker.log.toonl"),
        pid: 4_000 + born,
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
      child: { pid: 4_000 + born, once: () => undefined, unref: () => undefined } as unknown as LaunchedWorker["child"],
    };
  };
}

interface Harness {
  readonly daemon: RedskilledDaemon;
  readonly eventLanePath: string;
  /** Birth one Worker, live `lifetimeMs`, then end it with this exit status. */
  kill(lifetimeMs: number, code: number | null): Promise<void>;
  advance(ms: number): void;
}

/** One daemon holding one registered project, with the Worker's last line posed. */
async function harness(tail: string | null): Promise<Harness> {
  let nowMs = START_MS;
  const exits = new Map<string, LaunchWorkerOptions["onExit"]>();
  const session = await scratch("redskilled-birth-outcome-");
  const workspace = await scratch("redskilled-birth-outcome-workspace-");
  const paths = resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${session}`, REDSKILLED_MACHINE_DIR: session },
    runtimeDir: session,
  });
  const daemon = await startRedskilledDaemon({
    paths,
    ceiling: UNBOUNDED_HOST_CEILING,
    clock: () => new Date(nowMs).toISOString(),
    sampleMs: 0,
    demandMs: 0,
    liveness: () => true,
    launch: exitableLaunch(exits),
    // The bounded tail read the daemon already performs on a death; posing it is
    // how a test says what the Worker's last line was without writing a log.
    readLogTail: async () => tail,
    queueDiscovery: { intervalMs: 0, transport: async () => answer(1) },
  });
  running.push(daemon);
  daemon.registerProject({
    project_label: PROJECT,
    selector: `repo:${PROJECT} label:ready-for-agent`,
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: workspace,
    target: 6,
  });
  return {
    daemon,
    eventLanePath: paths.eventLanePath,
    advance: (ms) => { nowMs += ms; },
    async kill(lifetimeMs, code) {
      await daemon.pollQueueDiscovery();
      const tick = await daemon.driveDemand();
      expect(tick.granted).toHaveLength(1);
      const workerId = tick.granted[0]!.worker_id;
      nowMs += lifetimeMs;
      exits.get(workerId)?.(workerId, code, null);
      await daemon.flushEvents();
      nowMs += 2_000;
    },
  };
}

describe("the daemon's birth breaker and a Worker's terminal outcome", () => {
  it("keeps asking after three clean NO MORE TASKS exits", async () => {
    const { daemon, kill } = await harness(NO_MORE_TASKS);
    for (let death = 0; death < REDSKILLED_SHORT_LIFE_STREAK; death += 1) await kill(4_000, 0);

    // Nothing latched, and the very next tick still births: the empty queue that
    // repaired itself is met by a Worker, not by a hand-cleared breaker.
    expect(daemon.hostState().birth_latches ?? []).toEqual([]);
    await daemon.pollQueueDiscovery();
    const after = await daemon.driveDemand();
    expect(after.granted).toHaveLength(1);
    expect(after.projects[0]?.outcome).toBe("asking");
  });

  it("still halts a project whose Workers end without reporting anything", async () => {
    const { daemon, kill, eventLanePath } = await harness("still booting");
    for (let death = 0; death < REDSKILLED_SHORT_LIFE_STREAK; death += 1) await kill(13_000, 1);

    expect(daemon.hostState().birth_latches?.[0]).toMatchObject({
      name: "project-birth-breaker",
      project_label: PROJECT,
      state: "open",
    });
    await daemon.pollQueueDiscovery();
    const held = await daemon.driveDemand();
    expect(held.granted).toEqual([]);
    expect(held.projects[0]?.outcome).toBe("birth-halted");

    // The refusal on the lane names which outcome class armed the latch, so an
    // operator reading it can tell a crashloop from a drained queue.
    await daemon.flushEvents();
    const refusals = (await readRedskilledEvents(eventLanePath)).filter(
      (event) => event.event === "demand-refusal",
    );
    expect(refusals.at(-1)).toMatchObject({
      project_label: PROJECT,
      detail: expect.stringContaining("unreported"),
    });
  });

  it("counts a Worker that printed the sentinel and then crashed anyway", async () => {
    // The sentence is a claim; the exit status is the outcome.
    const { daemon, kill } = await harness(NO_MORE_TASKS);
    for (let death = 0; death < REDSKILLED_SHORT_LIFE_STREAK; death += 1) await kill(13_000, 9);
    expect(daemon.hostState().birth_latches?.[0]).toMatchObject({ state: "open" });
  });
});

function answer(depth: number): unknown {
  return {
    data: {
      rateLimit: { remaining: 4_900, resetAt: null },
      q0: { issueCount: depth },
    },
  };
}
