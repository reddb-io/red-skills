import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIVENESS_LANE_FILENAME } from "@reddb-io/red-castle";
import {
  createCastleMcpTools,
  projectStatusOutputSchema,
  monitorOutputSchema,
  queueStatusOutputSchema,
  workerVitalsOutputSchema,
} from "../../../packages/red-castle/src/mcp-server.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildQueueStatus,
  createCastleMcpDependencies,
} from "../src/mcp-adapter.js";

/**
 * Round-trip proof for the declared observability contracts: the adapter builds
 * its payloads over FIXTURE state on disk, and those payloads validate against
 * the schemas red-castle publishes. A field the adapter stops emitting — or
 * emits with a different type — fails here rather than reaching a client.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dev-afk-contracts-"));
  roots.push(root);
  // The fixture states "no daemon answers", and the SUITE owns that absence:
  // this file pinned its own `XDG_RUNTIME_DIR` (#2884's rule, applied to a
  // contract test) until the pin moved into the package's setup file (#2981),
  // where every test inherits it instead of each one remembering it.
  await writeWorkerAttempt(root, "wHU5U", 2335);
  await writeFleetState(root);
  return root;
}

/** One live worker attempt: the state snapshot plus a fresh liveness lane, so
 * the record reads back renderable-live on every observability surface. */
async function writeWorkerAttempt(
  root: string,
  worker: string,
  issue: number,
): Promise<void> {
  const dir = join(root, ".red", "tmp", "workers", worker, String(issue));
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "afk.state.toon"),
    JSON.stringify({
      worker_id: worker,
      pid: process.pid,
      runner: "claude",
      origin: "afk",
      started_at: "2026-07-21T23:00:00.000Z",
      total: 1,
      done: 0,
      current: {
        number: issue,
        title: `issue ${issue}`,
        runner: "claude",
        phase: "coding",
        activity: "impl",
        started_at: "2026-07-21T23:00:00.000Z",
        loc_added: 12,
        loc_removed: 3,
        tools_called_count: 7,
      },
    }),
    "utf8",
  );
  await writeFile(
    join(dir, LIVENESS_LANE_FILENAME),
    `${JSON.stringify({ at: Date.now() - 5_000, kind: "iteration-start" })}\n`,
    "utf8",
  );
}

async function writeFleetState(root: string): Promise<void> {
  const dir = join(root, ".red", "tmp", "supervisors", "default");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "state.toon"),
    JSON.stringify({
      ts: "2026-07-21T23:00:00.000Z",
      epoch: Math.floor(Date.now() / 1_000),
      runner: "claude",
      target: 2,
      bundle_version: "2.76.1",
      ready_for_agent: 4,
      slots: { busy: 1, free: 1, parked: 0, total: 2 },
      spawns_this_tick: 1,
      churn: { deaths: 0, respawns: 0, window_s: 300 },
    }),
    "utf8",
  );
}

describe("dev:afk observability output contracts", () => {
  it("builds a project_status payload that satisfies the declared contract", async () => {
    const root = await fixtureRoot();
    const status = await createCastleMcpDependencies(root).projectStatus();

    // No daemon answers in the fixture, so the registration reports the host's
    // silence rather than inventing a record — the distinction `daemon_reachable`
    // exists to carry.
    expect(projectStatusOutputSchema.parse(status)).toMatchObject({
      registration: { held: false, daemon_reachable: false, target: 0 },
      slots: { busy: 0, total: 0 },
    });
  });

  it("builds a worker_vitals payload that satisfies the declared contract", async () => {
    const root = await fixtureRoot();
    const vitals = await createCastleMcpDependencies(root).workerVitals({});

    expect(vitals).toHaveLength(1);
    expect(workerVitalsOutputSchema.parse(vitals)[0]).toMatchObject({
      worker: {
        id: "wHU5U",
        runner: "claude",
        origin: "afk",
        current: { number: 2335, activity: "impl", loc_added: 12 },
      },
    });
  });

  it("builds a monitor payload that satisfies the declared contract", async () => {
    const root = await fixtureRoot();
    const monitor = await createCastleMcpDependencies(root).monitor();

    const parsed = monitorOutputSchema.parse(monitor);
    expect(parsed.fleet).toMatchObject({ runner: "claude", slotsTotal: 2 });
    expect(parsed.workers.map((worker) => worker.state.worker_id)).toEqual([
      "wHU5U",
    ]);
  });

  it("keeps a worker fields projection callable through scoped status", async () => {
    const root = await fixtureRoot();
    const tools = createCastleMcpTools(createCastleMcpDependencies(root));
    const status = tools.find((tool) => tool.name === "status")!;

    // A caller-requested projection is a deliberate narrowing of the declared
    // shape — the contract must not turn that supported input into an error.
    await expect(
      status.invoke({
        scope: "worker",
        live_only: true,
        fields: ["live", "liveness"],
      }),
    ).resolves.toMatchObject({
      vitals: [{ live: true, liveness: "active" }],
    });
  });

  it("builds a queue_status payload that satisfies the declared contract", () => {
    const queue = buildQueueStatus(
      [
        {
          number: 2335,
          title: "E1",
          body: "the full issue body",
          labels: ["type:ticket"],
        },
      ],
      [
        {
          number: 2062,
          title: "bot-authored canonical ticket",
          body: "maintainer-curated body",
          labels: ["ready-for-agent"],
          author: "github-actions",
        },
      ],
      [
        {
          number: 2334,
          title: "H3",
          labels: ["ready-for-human"],
          createdAt: null,
        },
      ],
    );

    expect(queueStatusOutputSchema.parse(queue)).toEqual({
      ready_for_agent: {
        eligible: [{ number: 2335, title: "E1", labels: ["type:ticket"] }],
        held_for_summon: [
          {
            number: 2062,
            title: "bot-authored canonical ticket",
            labels: ["ready-for-agent"],
          },
        ],
      },
      ready_for_human: [
        {
          number: 2334,
          title: "H3",
          labels: ["ready-for-human"],
          createdAt: null,
        },
      ],
      counts: {
        ready_for_agent_eligible: 1,
        ready_for_agent_held: 1,
        ready_for_human: 1,
      },
    });
  });
});
