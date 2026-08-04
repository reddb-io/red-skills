// A birth-eligible project can be idle only with a stated reason (#3267).
// The daemon used to keep its project birth breaker solely in process memory:
// host_state showed open work, free slots and no Workers while naming no latch,
// and the demand tick that refused the birth left no durable event behind.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  REDSKILLED_BIRTH_HALT_MS,
  REDSKILLED_SHORT_LIFE_MS,
  REDSKILLED_SHORT_LIFE_STREAK,
} from "../src/demand-loop.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { LaunchedWorker, LaunchWorkerOptions } from "../src/worker-launch.js";

const START_MS = Date.parse("2026-08-04T13:03:15.000Z");
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

function recordingLaunch(launched: LaunchWorkerOptions[]) {
  let born = 0;
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    if (!options.admission.admitted) throw new Error(options.admission.reason);
    launched.push(options);
    born += 1;
    return {
      worker: {
        worker_id: `w${born}`,
        project_label: options.spec.project_label,
        workspace_path: options.spec.workspace_path,
        pid: 4_000 + born,
        started_at: options.clock(),
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

describe("the daemon's project birth latch", () => {
  it("reports, records, half-opens one probe, and reopens on a failed probe", async () => {
    let nowMs = START_MS;
    let depth = 1;
    const launched: LaunchWorkerOptions[] = [];
    const session = await scratch("redskilled-birth-latch-");
    const workspace = await scratch("redskilled-birth-latch-workspace-");
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
      launch: recordingLaunch(launched),
      queueDiscovery: { intervalMs: 0, transport: async () => answer(depth) },
    });
    running.push(daemon);
    daemon.registerProject({
      project_label: PROJECT,
      selector: `repo:${PROJECT} label:ready-for-agent`,
      argv: ["red-skills-dev", "run", "--once"],
      workspace_path: workspace,
      target: 6,
    });

    // Three short lives trip the breaker. A depth of one keeps each tick to one
    // birth so this is the observed consecutive-death shape, not a burst.
    for (let death = 0; death < REDSKILLED_SHORT_LIFE_STREAK; death += 1) {
      await daemon.pollQueueDiscovery();
      const tick = await daemon.driveDemand();
      expect(tick.granted).toHaveLength(1);
      nowMs += 13_000;
      expect(daemon.releaseWorker(tick.granted[0]!.worker_id)).toBe(true);
      nowMs += 2_000;
    }

    const openedAt = new Date(nowMs - 2_000).toISOString();
    const state = daemon.hostState();
    expect(state.birth_latches).toEqual([
      expect.objectContaining({
        name: "project-birth-breaker",
        project_label: PROJECT,
        state: "open",
        opened_at: openedAt,
        reason: expect.stringContaining(`${REDSKILLED_SHORT_LIFE_STREAK} Workers`),
        closes: expect.stringContaining("one probe Worker"),
        repair: {
          tool: "project_reset",
          args: { latch: "project-birth-breaker" },
          why: expect.stringContaining("clear"),
        },
      }),
    ]);

    // Positive depth + six free slots + no birth must leave a host event naming
    // the refusal. This is the record the three-hour stall had none of.
    await daemon.pollQueueDiscovery();
    const held = await daemon.driveDemand();
    expect(held.granted).toEqual([]);
    expect(held.projects[0]?.outcome).toBe("birth-halted");
    await daemon.flushEvents();
    const refusals = (await readRedskilledEvents(paths.eventLanePath)).filter(
      (event) => event.event === "demand-refusal",
    );
    expect(refusals.at(-1)).toMatchObject({
      project_label: PROJECT,
      detail: expect.stringContaining("not asked for another"),
    });

    // After cooldown the breaker is half-open: even with six queued and six
    // free, exactly one birth is admitted. A second tick waits on that probe.
    nowMs = Date.parse(openedAt) + REDSKILLED_BIRTH_HALT_MS;
    depth = 6;
    await daemon.pollQueueDiscovery();
    const probe = await daemon.driveDemand();
    expect(probe.granted).toHaveLength(1);
    expect(probe.projects[0]?.outcome).toBe("half-open-probe");
    expect(daemon.hostState().birth_latches?.[0]).toMatchObject({
      state: "half-open",
      probe_worker_id: probe.granted[0]!.worker_id,
    });
    expect((await daemon.driveDemand()).granted).toEqual([]);

    // A fast probe death re-opens immediately and dates the new refusal to this
    // death, rather than leaving the original trip timestamp latched forever.
    nowMs += Math.min(13_000, REDSKILLED_SHORT_LIFE_MS - 1);
    daemon.releaseWorker(probe.granted[0]!.worker_id);
    expect(daemon.hostState().birth_latches?.[0]).toMatchObject({
      state: "open",
      opened_at: new Date(nowMs).toISOString(),
    });
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
