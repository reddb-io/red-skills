// A spent quota is not an empty queue (issue #2904). A queue fetch has three
// distinguishable outcomes — unreachable, rate-limited, counted — and only the
// last of them is ever a number. This file holds the fixtures for the half a
// consumer reads: the outcomes ride on the statusline payload, the last depth a
// selector actually returned survives the failure that followed it with its own
// age, and one project's refused query leaves its neighbours' depths alone.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildQueueReport,
  fetchQueueDiscovery,
  type RedskilledProjectSelector,
} from "../src/queue-discovery.js";
import { buildStatuslinePayload, isRedskilledStatuslinePayload } from "../src/statusline-payload.js";
import { buildHostState } from "../src/host-state.js";

const NOW = "2026-07-31T12:00:00.000Z";
const LATER = "2026-07-31T12:00:20.000Z";

function selector(index: number): RedskilledProjectSelector {
  return { project_label: `acme/p${index}`, selector: `repo:acme/p${index} label:ready-for-agent` };
}

/** The answer a token with nothing left gives: a rate limit, and no counts. */
const SPENT = {
  data: { rateLimit: { remaining: 0, resetAt: "2026-07-31T13:00:00.000Z" } },
  errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
};

function counted(depths: readonly number[]) {
  const data: Record<string, unknown> = { rateLimit: { remaining: 4900, resetAt: "2026-07-31T13:00:00.000Z" } };
  depths.forEach((depth, index) => {
    data[`q${index}`] = { issueCount: depth };
  });
  return { data };
}

describe("the last depth a selector returned outlives the failure after it", () => {
  it("carries the previous count and its own instant through a spent quota", async () => {
    const first = await fetchQueueDiscovery({
      projects: [selector(0)],
      now: NOW,
      transport: async () => counted([6]),
    });
    const second = await fetchQueueDiscovery({
      projects: [selector(0)],
      now: LATER,
      previous: first,
      transport: async () => SPENT,
    });

    // The fetch that failed reports a failure, not a drained queue...
    expect(second.projects[0]).toMatchObject({ outcome: "rate-limited", depth: null });
    // ...and still says what the last successful read saw, and when.
    expect(second.projects[0]!.last_counted_depth).toBe(6);
    expect(second.projects[0]!.last_counted_at).toBe(NOW);
  });

  it("ages the last successful read separately from the failed poll that replaced it", async () => {
    const first = await fetchQueueDiscovery({ projects: [selector(0)], now: NOW, transport: async () => counted([6]) });
    const second = await fetchQueueDiscovery({
      projects: [selector(0)],
      now: LATER,
      previous: first,
      transport: async () => SPENT,
    });
    const report = buildQueueReport({ discovery: second, now: LATER });

    expect(report.age_ms).toBe(0);
    // 20s between the counted poll and now — the number a consumer needs to
    // decide whether the held depth is still worth acting on.
    expect(report.projects[0]!.last_counted_age_ms).toBe(20_000);
  });

  it("holds no phantom count for a selector that has never answered", async () => {
    const discovery = await fetchQueueDiscovery({ projects: [selector(0)], now: NOW, transport: async () => SPENT });
    const report = buildQueueReport({ discovery, now: NOW });

    expect(report.projects[0]!.last_counted_depth).toBeNull();
    expect(report.projects[0]!.last_counted_at).toBeNull();
    expect(report.projects[0]!.last_counted_age_ms).toBeNull();
  });

  it("does not let one project's failure overwrite another project's count", async () => {
    const first = await fetchQueueDiscovery({
      projects: [selector(0), selector(1)],
      now: NOW,
      transport: async () => counted([6, 9]),
    });
    const second = await fetchQueueDiscovery({
      projects: [selector(0), selector(1)],
      now: LATER,
      previous: first,
      transport: async () => ({
        data: { rateLimit: { remaining: 4900, resetAt: null }, q1: { issueCount: 4 } },
        errors: [{ path: ["q0"], message: "Could not resolve to a Repository" }],
      }),
    });

    expect(second.projects[0]).toMatchObject({ outcome: "unreachable", depth: null, last_counted_depth: 6 });
    expect(second.projects[1]).toMatchObject({ outcome: "counted", depth: 4, last_counted_depth: 4 });
    expect(second.projects[1]!.last_counted_at).toBe(LATER);
  });
});

describe("the three outcomes ride on the payload a consumer reads", () => {
  function payload(discovery: Parameters<typeof buildQueueReport>[0]["discovery"], now: string) {
    return buildStatuslinePayload({
      hostState: buildHostState({
        daemonVersion: "0.0.0-test",
        machineIdHash: "hash",
        sessionKeyHash: "session",
        pid: 4242,
        startedAt: NOW,
        workers: [],
        registrations: [],
      }),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: null,
      now,
      queueDiscovery: discovery,
    });
  }

  it("names a spent quota on the payload rather than reporting no work", async () => {
    const discovery = await fetchQueueDiscovery({ projects: [selector(0)], now: NOW, transport: async () => SPENT });
    const built = payload(discovery, NOW);

    expect(isRedskilledStatuslinePayload(built)).toBe(true);
    expect(built.queue.projects[0]!.outcome).toBe("rate-limited");
    expect(built.queue.projects[0]!.depth).toBeNull();
    expect(built.queue.rate_limit.exhausted).toBe(true);
    expect(built.queue.projects[0]!.detail).toContain("quota");
  });

  it("tells an unreachable project, a rate-limited one and a drained one apart", async () => {
    const discovery = await fetchQueueDiscovery({
      projects: [selector(0), selector(1)],
      now: NOW,
      transport: async () => ({
        data: { rateLimit: { remaining: 4900, resetAt: null }, q1: { issueCount: 0 } },
        errors: [{ path: ["q0"], message: "Could not resolve to a Repository" }],
      }),
    });
    const built = payload(discovery, NOW);

    expect(built.queue.projects.map((entry) => entry.outcome)).toEqual(["unreachable", "counted"]);
    expect(built.queue.projects.map((entry) => entry.depth)).toEqual([null, 0]);
  });

  it("carries an honest absence when the daemon polls no selector at all", () => {
    const built = payload(null, NOW);

    expect(built.queue.projects).toEqual([]);
    expect(built.queue.fetched_at).toBeNull();
    expect(built.queue.stale).toBe(false);
  });
});

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-quota-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

describe("the daemon publishes the queue outcome it last observed", () => {
  it("reports a spent quota on the payload, with the depth the previous poll held", async () => {
    const answers: unknown[] = [counted([3]), SPENT];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: { intervalMs: 0, transport: async () => answers.shift() ?? SPENT },
    });
    running.push(daemon);
    daemon.registerProject({
      project_label: "acme/p0",
      selector: "repo:acme/p0 label:ready-for-agent",
      argv: ["red-skills-dev", "work"],
      target: 1,
    });

    await daemon.pollQueueDiscovery();
    const first = daemon.statuslinePayload();
    expect(first.queue.projects[0]).toMatchObject({ outcome: "counted", depth: 3 });

    await daemon.pollQueueDiscovery();
    const second = daemon.statuslinePayload();
    expect(second.queue.projects[0]).toMatchObject({ outcome: "rate-limited", depth: null, last_counted_depth: 3 });
    expect(second.queue.rate_limit.exhausted).toBe(true);
  });
});
