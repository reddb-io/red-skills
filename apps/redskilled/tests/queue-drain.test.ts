// A project whose queue is GENUINELY empty leaves the daemon's list (ADR 0130
// Amendment 3, issue #2905): an empty selector polled forever is the standing
// cost the batching Spec exists to remove. Only a counted zero deregisters — a
// spent quota and an unreachable selector carry no depth, so a project behind
// either of them stays registered and keeps being asked.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { planQueueDrain } from "../src/queue-drain.js";
import type { RedskilledQueueDiscovery, RedskilledProjectQueue } from "../src/queue-discovery.js";

const NOW = "2026-07-31T12:00:00.000Z";

function discovery(projects: readonly RedskilledProjectQueue[]): RedskilledQueueDiscovery {
  return {
    version: 1,
    fetched_at: NOW,
    request_count: 1,
    project_count: projects.length,
    batch_size: 50,
    rate_limit: { remaining: 4900, reset_at: null, exhausted: false },
    projects,
  };
}

function counted(label: string, depth: number): RedskilledProjectQueue {
  return { project_label: label, outcome: "counted", depth, detail: `${label} has ${depth} item(s)` };
}

function failed(label: string, outcome: "unreachable" | "rate-limited"): RedskilledProjectQueue {
  return { project_label: label, outcome, depth: null, detail: `${label} carries no depth` };
}

describe("only a counted zero drains a project", () => {
  it("deregisters the genuinely empty queue and holds every project that still has work", () => {
    const plan = planQueueDrain({
      discovery: discovery([counted("acme/empty", 0), counted("acme/busy", 3)]),
      registered: ["acme/busy", "acme/empty"],
      now: NOW,
    });

    expect(plan.deregistered).toEqual(["acme/empty"]);
    expect(plan.decisions.map((decision) => decision.project_label)).toEqual(["acme/busy", "acme/empty"]);
    expect(plan.decisions.find((d) => d.project_label === "acme/busy")!.deregistered).toBe(false);
  });

  it("never mistakes a spent quota or an unreachable selector for a drained queue", () => {
    const plan = planQueueDrain({
      discovery: discovery([failed("acme/spent", "rate-limited"), failed("acme/lost", "unreachable")]),
      registered: ["acme/lost", "acme/spent"],
      now: NOW,
    });

    expect(plan.deregistered).toEqual([]);
    for (const decision of plan.decisions) {
      expect(decision.deregistered).toBe(false);
      expect(decision.reason).toMatch(/no depth|quota|reach/i);
    }
  });

  it("holds a project this poll never asked about, and every project when nothing was polled", () => {
    const midFlight = planQueueDrain({
      discovery: discovery([counted("acme/empty", 0)]),
      registered: ["acme/empty", "acme/fresh"],
      now: NOW,
    });
    expect(midFlight.deregistered).toEqual(["acme/empty"]);
    expect(midFlight.decisions.find((d) => d.project_label === "acme/fresh")!.deregistered).toBe(false);

    expect(planQueueDrain({ discovery: null, registered: ["acme/empty"], now: NOW }).deregistered).toEqual([]);
  });

  it("keeps a drained project whose Worker is still alive, because that Worker is its remaining work", () => {
    const plan = planQueueDrain({
      discovery: discovery([counted("acme/empty", 0)]),
      registered: ["acme/empty"],
      busyProjects: ["acme/empty"],
      now: NOW,
    });

    expect(plan.deregistered).toEqual([]);
    expect(plan.decisions[0]!.reason).toMatch(/Worker/);
  });
});

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-drain-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function registration(index: number) {
  return {
    project_label: `acme/p${index}`,
    selector: `repo:acme/p${index} label:ready-for-agent`,
    argv: ["red-skills-dev", "work"],
    target: 1,
  };
}

/** One tracker answer: a depth per alias, in the order the batch was built. */
function answer(depths: readonly (number | null)[]) {
  const data: Record<string, unknown> = { rateLimit: { remaining: 4900, resetAt: null } };
  depths.forEach((depth, index) => {
    if (depth != null) data[`q${index}`] = { issueCount: depth };
  });
  return { data };
}

describe("a drained project leaves the daemon's list", () => {
  it("drops the drained project from host-state, stops asking about it, and takes it back later", async () => {
    const queries: string[] = [];
    let call = 0;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: {
        intervalMs: 0,
        transport: async (query) => {
          queries.push(query);
          call += 1;
          // First poll: p0 has drained, p1 still has work. Later polls answer
          // one depth per alias for whatever is still registered.
          if (call === 1) return answer([0, 4]);
          return answer(Array.from({ length: query.match(/q\d+: search/g)?.length ?? 0 }, () => 4));
        },
      },
    });
    running.push(daemon);

    daemon.registerProject(registration(0));
    daemon.registerProject(registration(1));
    await daemon.pollQueueDiscovery();

    expect(daemon.registrations().map((entry) => entry.project_label)).toEqual(["acme/p1"]);
    expect(daemon.hostState().registrations!.map((entry) => entry.project_label)).toEqual(["acme/p1"]);

    // Not in the next aliased request: the drained selector is gone from the query.
    await daemon.pollQueueDiscovery();
    expect(queries[1]).not.toContain("acme/p0");
    expect(queries[1]).toContain("acme/p1");

    // Re-registering a drained project is a fresh registration, not a duplicate.
    expect(() => daemon.registerProject(registration(0))).not.toThrow();
    expect(daemon.registrations().map((entry) => entry.project_label)).toEqual(["acme/p0", "acme/p1"]);
  });

  it("keeps a project the fetch could not count, so a spent quota never retires live work", async () => {
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: {
        intervalMs: 0,
        transport: async () => {
          throw new Error("API rate limit exceeded");
        },
      },
    });
    running.push(daemon);

    daemon.registerProject(registration(0));
    const fetched = await daemon.pollQueueDiscovery();

    expect(fetched!.projects[0]!.outcome).toBe("rate-limited");
    expect(daemon.registrations().map((entry) => entry.project_label)).toEqual(["acme/p0"]);
  });
});
