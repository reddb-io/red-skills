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
import {
  expandLaunchTemplate,
  type RedskilledLaunchTemplate,
} from "@reddb-io/redskilled/launch-template";
import { attributeProjectWorkers } from "../src/core/project-attribution.js";
import { resolveWorkerId } from "../src/core/session.js";

const BUNDLE_ARGV = ["/usr/bin/node", "/published/bundle.mjs"] as const;

/**
 * A launch as the DAEMON states it — placeholders, not values, because one
 * template serves every Worker it births.
 *
 * Written out here rather than built by a project-side composer: ADR 0148 makes
 * the daemon compose its own launch, so what this file pins is the CONTRACT the
 * env carries (`{{worker_id}}` reaching the process as the id it files itself
 * under), not who assembled the words.
 */
function launch(runner = "claude", path = "/published/node_modules/.bin:/usr/bin"): RedskilledLaunchTemplate {
  return {
    argv: [...BUNDLE_ARGV, "run", "--once", "--runner", runner],
    env: {
      RED_AFK_WORKER_ID: "{{worker_id}}",
      REDSKILLED_WORKER_ID: "{{worker_id}}",
      RED_AFK_SLOT: "{{slot}}",
      RED_AFK_RUNNER: runner,
      PATH: path,
    },
    log_path: "/repo/.red/tmp/logs/2026-08-03/worker-{{worker_id}}.log",
  };
}

/** One Worker, born the way the daemon births it. */
function born(hostWorkerId: string, slot: number, runner = "claude") {
  const expanded = expandLaunchTemplate(launch(runner), {
    worker_id: hostWorkerId,
    slot,
    workspace_path: "/repo",
  });
  // The Worker's side of the same birth: it reads the env it was started with
  // and decides what to call itself.
  const projectWorkerId = resolveWorkerId(expanded.env.RED_AFK_WORKER_ID);
  return { expanded, projectWorkerId };
}

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
  const worker = (id: string, pid = process.pid, pidLive = true) => ({
    state: { worker_id: id, pid },
    pidLive,
  });

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
      workerIdEnvDeclared: false,
    });

    expect(attribution.live).toEqual([]);
    expect(attribution.warnings).toHaveLength(1);
    expect(attribution.warnings[0]).toContain("disjoint");
    expect(attribution.warnings[0]).toContain("#3081");
  });

  it("does not blame a declared launch env for disjoint live ids", () => {
    const attribution = attributeProjectWorkers({
      workers: [worker("project-id")],
      hostWorkerIds: ["host-id"],
      workerIdEnvDeclared: true,
    });

    expect(attribution.live).toEqual([]);
    expect(attribution.warnings).toEqual([]);
  });

  it("bars pid-zero and dead-pid rows from the live claim, but keeps them visible", () => {
    const attribution = attributeProjectWorkers({
      workers: [
        worker("pid-zero", 0, false),
        worker("dead-pid", 919_191, false),
      ],
      hostWorkerIds: ["host-id"],
      workerIdEnvDeclared: true,
    });

    // Disproof bars LIVE; it never shrinks the report. A dead row rendered as
    // live was the #3660 bug — a dead row vanishing entirely would be the
    // opposite lie, so both land in unattributed.
    expect(attribution.live).toEqual([]);
    expect(attribution.unattributed.map((w) => w.state.worker_id)).toEqual([
      "pid-zero",
      "dead-pid",
    ]);
    expect(attribution.warnings).toEqual([]);
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

  // #3123: the host said `1w`, `project_status` said none, and neither said the
  // two disagreed. That silence is what let a record outlive its Worker for two
  // hours while a queue of eight went undrained.
  it("reports a host count this checkout can see no trace of", () => {
    const attribution = attributeProjectWorkers({
      workers: [],
      hostWorkerIds: ["71982926-abf"],
      hostWorkerBirths: { "71982926-abf": "2026-08-03T01:52:04.000Z" },
      nowMs: Date.parse("2026-08-03T03:52:04.000Z"),
    });

    expect(attribution.live).toEqual([]);
    expect(attribution.busy).toBe(1);
    expect(attribution.warnings).toHaveLength(1);
    expect(attribution.warnings[0]).toContain("71982926-abf");
    expect(attribution.warnings[0]).toContain("disagree");
  });

  it("stays quiet through the newborn window, where the host is simply ahead", () => {
    // The canary's own shape: a Worker born a second ago holds its slot before it
    // has written any project-side state, and calling that a phantom would put a
    // false alarm on every single birth.
    const attribution = attributeProjectWorkers({
      workers: [],
      hostWorkerIds: ["fresh-1"],
      hostWorkerBirths: { "fresh-1": "2026-08-03T03:52:03.000Z" },
      nowMs: Date.parse("2026-08-03T03:52:04.000Z"),
    });

    expect(attribution.warnings).toEqual([]);
    expect(attribution.busy).toBe(1);
  });

  it("says nothing when the host's Workers cannot be dated at all", () => {
    // No evidence is not evidence of a phantom.
    expect(attributeProjectWorkers({ workers: [], hostWorkerIds: ["undated"] }).warnings).toEqual([]);
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
