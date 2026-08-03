// One Worker, one id (#3081).
//
// `project_status` — the tool `/afk` documents as read-only ground truth for
// "what is actually running?" — reported an empty fleet over two Workers that
// were mid-review on this repository's own issues. Nothing was wrong with the
// Workers: the launch template's env never reached the process, so the Worker
// never received the id the host had assigned and minted its own. Attribution
// then compared daemon ids against project ids, and the two sets were
// STRUCTURALLY disjoint — the predicate was false for every Worker, always.
//
// What is pinned here is the whole wire, end to end: the launch a registration
// states, the facts the daemon writes into it, the id the Worker adopts from the
// result, and the attribution that joins the two ends back together.
import { describe, expect, it } from "vitest";
import { expandLaunchTemplate } from "@reddb-io/redskilled/launch-template";
import { attributeProjectWorkers } from "../src/core/project-attribution.js";
import { resolveWorkerId } from "../src/core/session.js";
import { registrationLaunch } from "../src/runtime/registration-launch.js";

const BUNDLE_ARGV = ["/usr/bin/node", "/published/bundle.mjs"] as const;

/** The launch a `project_start` hands the daemon, with no host in the test. */
function launch(runner = "claude") {
  return registrationLaunch({
    runner,
    bundleArgv: BUNDLE_ARGV,
    logPath: "/repo/.red/tmp/logs/2026-08-03/worker-{{worker_id}}.log",
  });
}

/** One Worker, born the way the daemon births it from a registration. */
function born(hostWorkerId: string, slot: number, runner = "claude") {
  const expanded = expandLaunchTemplate(launch(runner), {
    worker_id: hostWorkerId,
    slot,
    workspace_path: "/repo",
  });
  // The project's side of the same birth: `run` reads the env it was started
  // with and decides what to call itself.
  const projectWorkerId = resolveWorkerId(expanded.env.RED_AFK_WORKER_ID);
  return { expanded, projectWorkerId };
}

describe("the launch a registration states", () => {
  it("carries the id, the slot and the runner a Worker needs to know itself", () => {
    const stated = launch("codex");

    // Placeholders, not values: one registration serves every Worker it births.
    expect(stated.env?.RED_AFK_WORKER_ID).toBe("{{worker_id}}");
    expect(stated.env?.RED_AFK_SLOT).toBe("{{slot}}");
    expect(stated.env?.RED_AFK_RUNNER).toBe("codex");
  });

  it("carries the project's own env passthrough alongside them", () => {
    // The host's handle for the process rides beside the work's id rather than
    // instead of it: a heartbeat is addressed with the daemon's string (#3079).
    expect(launch().env?.REDSKILLED_WORKER_ID).toBe("{{worker_id}}");
  });

  it("delivers all four to the process, with the daemon's facts written in", () => {
    const { expanded } = born("2aa48bea-81a5-409d-9310-ab0a9805", 1, "codex");

    expect(expanded.env.RED_AFK_WORKER_ID).toBe("2aa48bea-81a5-409d-9310-ab0a9805");
    expect(expanded.env.RED_AFK_SLOT).toBe("1");
    expect(expanded.env.RED_AFK_RUNNER).toBe("codex");
    expect(expanded.env.REDSKILLED_WORKER_ID).toBe("2aa48bea-81a5-409d-9310-ab0a9805");
    // The argv half always arrived, which is why the loss stayed invisible.
    expect(expanded.argv).toEqual([...BUNDLE_ARGV, "run", "--once", "--runner", "codex"]);
  });
});

describe("host-side and project-side worker ids", () => {
  it("are the same string for one Worker", () => {
    // The disjointness the issue describes, made impossible to reintroduce: the
    // daemon's id IS the id the work files itself under.
    const hostWorkerId = "2aa48bea-81a5-409d-9310-ab0a9805";
    const { projectWorkerId } = born(hostWorkerId, 0);

    expect(projectWorkerId).toBe(hostWorkerId);
  });

  it("stay the same string across every slot of one registration", () => {
    const ids = ["host-a", "host-b", "host-c"];
    const workers = ids.map((id, slot) => born(id, slot));

    expect(workers.map((w) => w.projectWorkerId)).toEqual(ids);
    // And each Worker still learns the slot it was placed on, so per-slot state
    // is addressable rather than permanently slot 0.
    expect(workers.map((w) => w.expanded.env.RED_AFK_SLOT)).toEqual(["0", "1", "2"]);
  });

  it("still mints an id when no host assigned one", () => {
    // The standalone lane: a directly-invoked `run` with no daemon in it.
    const minted = resolveWorkerId(undefined, () => false, () => 0);
    expect(minted).toMatch(/^w[A-Z0-9]{4}$/);
    expect(resolveWorkerId("   ", () => false, () => 0)).toBe(minted);
  });

  it("adopts the assigned id even when a directory of that name exists", () => {
    // No fallback, deliberately: an id generator that runs after the host has
    // already named the Worker is the defect, not a safety net.
    expect(resolveWorkerId("host-a", () => true)).toBe("host-a");
  });
});

describe("attributing live Workers to this project", () => {
  const worker = (id: string) => ({ state: { worker_id: id } });

  it("lists a Worker born from a registration as this project's own", () => {
    const hostWorkerId = "2aa48bea-81a5-409d-9310-ab0a9805";
    const { projectWorkerId } = born(hostWorkerId, 0);

    const attribution = attributeProjectWorkers({
      workers: [worker(projectWorkerId)],
      hostWorkerIds: [hostWorkerId],
    });

    expect(attribution.live.map((w) => w.state.worker_id)).toEqual([hostWorkerId]);
    expect(attribution.unattributed).toEqual([]);
    expect(attribution.warnings).toEqual([]);
  });

  it("counts busy slots from the host, which owns birth", () => {
    // A Worker born a moment ago holds its slot before it has written any
    // project-side state; a count that waited for that file would read free
    // while the daemon refused to fill it.
    const attribution = attributeProjectWorkers({
      workers: [worker("host-a")],
      hostWorkerIds: ["host-a", "host-b"],
    });

    expect(attribution.busy).toBe(2);
  });

  it("keeps another project's Workers unattributed, and stays quiet about it", () => {
    const attribution = attributeProjectWorkers({
      workers: [worker("ours"), worker("theirs")],
      hostWorkerIds: ["ours"],
    });

    expect(attribution.live.map((w) => w.state.worker_id)).toEqual(["ours"]);
    expect(attribution.unattributed.map((w) => w.state.worker_id)).toEqual(["theirs"]);
    expect(attribution.warnings).toEqual([]);
  });

  it("reports a predicate that matches NOTHING across a non-empty Worker set", () => {
    // The #3081 signature: the host holds Workers for this project, live Workers
    // are running here, and not one of them matches. An empty `live_workers`
    // renders exactly like an idle repository, and this is the opposite state.
    const attribution = attributeProjectWorkers({
      workers: [worker("wS807"), worker("wVHHH")],
      hostWorkerIds: ["2aa48bea-81a5-409d-9310-ab0a9805", "8c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f"],
    });

    expect(attribution.live).toEqual([]);
    expect(attribution.warnings).toHaveLength(1);
    expect(attribution.warnings[0]).toContain("disjoint");
    expect(attribution.warnings[0]).toContain("#3081");
  });

  it("says the host did not answer rather than calling every Worker foreign", () => {
    const attribution = attributeProjectWorkers({
      workers: [worker("wS807")],
      hostWorkerIds: null,
    });

    expect(attribution.live).toEqual([]);
    expect(attribution.unattributed).toHaveLength(1);
    expect(attribution.warnings[0]).toContain("did not answer");
    // An unreachable host states no occupancy at all, and a live Worker this
    // checkout can see is not evidence of an occupied slot of OURS. The zero
    // rides with the warning, which is what keeps it from reading as idle.
    expect(attribution.busy).toBe(0);
  });

  it("stays quiet when there is genuinely nothing running", () => {
    expect(attributeProjectWorkers({ workers: [], hostWorkerIds: [] })).toEqual({
      live: [],
      unattributed: [],
      busy: 0,
      warnings: [],
    });
  });
});
