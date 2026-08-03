// The daemon discovers every registered project's queue depth in ONE aliased
// request per interval (ADR 0130 Amendment 3), on a cadence of its own next to
// the activity poller's, covering a project count past the batch bound with
// further requests rather than truncating it, and never letting a spent quota or
// an unresolvable selector read as a drained queue.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildQueueDiscoveryQuery,
  buildQueueReport,
  emptyQueueDiscovery,
  fetchQueueDiscovery,
  isRedskilledQueueReport,
  planQueueDiscoveryBatches,
  REDSKILLED_QUEUE_BATCH_SIZE,
  REDSKILLED_QUEUE_STALENESS_MS,
  type RedskilledProjectSelector,
} from "../src/queue-discovery.js";

const NOW = "2026-07-31T12:00:00.000Z";

function selector(index: number, overrides: Partial<RedskilledProjectSelector> = {}): RedskilledProjectSelector {
  return { project_label: `acme/p${index}`, selector: `repo:acme/p${index} label:ready-for-agent`, ...overrides };
}

/** One tracker answer: a depth per alias, in the order the batch was built. */
function answer(depths: readonly number[], rateLimit: unknown = { remaining: 4900, resetAt: "2026-07-31T13:00:00.000Z" }) {
  const data: Record<string, unknown> = { rateLimit };
  depths.forEach((depth, index) => {
    data[`q${index}`] = { issueCount: depth };
  });
  return { data };
}

describe("one request per interval, whatever the project count", () => {
  it("spans every registered selector in a single aliased query", () => {
    const projects = [selector(0), selector(1), selector(2)];
    const operation = buildQueueDiscoveryQuery(projects);

    expect(operation.aliases).toHaveLength(3);
    expect(operation.query.match(/query /g)).toHaveLength(1);
    for (let index = 0; index < projects.length; index += 1) {
      expect(operation.query).toContain(`q${index}: search(query: ${JSON.stringify(projects[index]!.selector)}`);
    }
  });

  it("issues one request for N projects, not N requests", async () => {
    const projects = [selector(0), selector(1), selector(2), selector(3), selector(4)];
    const queries: string[] = [];

    const discovery = await fetchQueueDiscovery({
      projects,
      now: NOW,
      transport: async (query) => {
        queries.push(query);
        return answer([7, 0, 3, 1, 12]);
      },
    });

    // The whole point of the amendment: cost is flat in the project count.
    expect(queries).toHaveLength(1);
    expect(discovery.request_count).toBe(1);
    expect(discovery.project_count).toBe(5);
    expect(discovery.projects.map((entry) => entry.depth)).toEqual([7, 0, 3, 1, 12]);
    expect(discovery.projects.every((entry) => entry.outcome === "counted")).toBe(true);
  });

  it("carries a drained queue as a counted zero, which is a fact and not an absence", async () => {
    const discovery = await fetchQueueDiscovery({
      projects: [selector(0)],
      now: NOW,
      transport: async () => answer([0]),
    });

    expect(discovery.projects[0]).toMatchObject({ outcome: "counted", depth: 0 });
  });

  it("carries no depth at all when nothing is registered", () => {
    const empty = emptyQueueDiscovery(NOW);
    expect(empty.request_count).toBe(0);
    expect(empty.projects).toEqual([]);
  });
});

describe("the batch bound is covered, never truncated", () => {
  it("splits a project count past the bound into whole batches that cover everyone", () => {
    const projects = Array.from({ length: 7 }, (_, index) => selector(index));
    const batches = planQueueDiscoveryBatches(projects, 3);

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.flat().map((entry) => entry.project_label)).toEqual(projects.map((entry) => entry.project_label));
  });

  it("fetches every project past the bound rather than dropping the remainder", async () => {
    const projects = Array.from({ length: 7 }, (_, index) => selector(index));
    const queries: string[] = [];

    const discovery = await fetchQueueDiscovery({
      projects,
      now: NOW,
      batchSize: 3,
      transport: async (query) => {
        queries.push(query);
        const aliases = query.match(/q\d+: search/g)?.length ?? 0;
        return answer(Array.from({ length: aliases }, () => 2));
      },
    });

    expect(queries).toHaveLength(3);
    expect(discovery.request_count).toBe(3);
    expect(discovery.projects.map((entry) => entry.project_label)).toEqual(projects.map((entry) => entry.project_label));
    expect(discovery.projects.every((entry) => entry.outcome === "counted")).toBe(true);
  });

  it("refuses a batch built past the bound instead of quietly cutting it", () => {
    const projects = Array.from({ length: 4 }, (_, index) => selector(index));
    expect(() => buildQueueDiscoveryQuery(projects, { batchSize: 3 })).toThrow(/split it with planQueueDiscoveryBatches/);
  });

  it("states a default bound one request can hold", () => {
    expect(Number.isInteger(REDSKILLED_QUEUE_BATCH_SIZE)).toBe(true);
    expect(REDSKILLED_QUEUE_BATCH_SIZE).toBeGreaterThan(0);
  });
});

describe("a failure is never a drained queue", () => {
  it("reads a spent quota as rate-limited, with no depth", async () => {
    const discovery = await fetchQueueDiscovery({
      projects: [selector(0), selector(1)],
      now: NOW,
      transport: async () => ({
        data: { rateLimit: { remaining: 0, resetAt: "2026-07-31T13:00:00.000Z" } },
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      }),
    });

    expect(discovery.projects.map((entry) => entry.outcome)).toEqual(["rate-limited", "rate-limited"]);
    expect(discovery.projects.map((entry) => entry.depth)).toEqual([null, null]);
    expect(discovery.rate_limit.exhausted).toBe(true);
  });

  it("fails one selector alone while its neighbours still count", async () => {
    const discovery = await fetchQueueDiscovery({
      projects: [selector(0), selector(1)],
      now: NOW,
      transport: async () => ({
        data: { rateLimit: { remaining: 4900, resetAt: null }, q0: { issueCount: 5 } },
        errors: [{ path: ["q1"], message: "Field 'search' argument 'query' is invalid" }],
      }),
    });

    expect(discovery.projects[0]).toMatchObject({ outcome: "counted", depth: 5 });
    expect(discovery.projects[1]).toMatchObject({ outcome: "unreachable", depth: null });
    expect(discovery.projects[1]!.detail).toContain("invalid");
  });

  it("carries a thrown transport as a stated failure rather than as zeros", async () => {
    const discovery = await fetchQueueDiscovery({
      projects: [selector(0), selector(1)],
      now: NOW,
      transport: async () => {
        throw new Error("the queue query was refused with HTTP 502");
      },
    });

    expect(discovery.projects.map((entry) => entry.outcome)).toEqual(["unreachable", "unreachable"]);
    expect(discovery.projects.map((entry) => entry.depth)).toEqual([null, null]);
    expect(discovery.projects[0]!.detail).toContain("HTTP 502");
  });

  it("refuses a project that names no work, and one registered twice", () => {
    expect(() => buildQueueDiscoveryQuery([selector(0, { selector: "" })])).toThrow(/needs a selector/);
    expect(() => buildQueueDiscoveryQuery([selector(0), selector(0)])).toThrow(/registered twice/);
  });
});

describe("the depths are dated by the poll they came from", () => {
  it("ages the depths inside the report instead of leaving the surface to guess", async () => {
    const discovery = await fetchQueueDiscovery({
      projects: [selector(0)],
      now: NOW,
      transport: async () => answer([4]),
    });
    const fresh = buildQueueReport({ discovery, now: new Date(Date.parse(NOW) + 1_000).toISOString() });
    const old = buildQueueReport({
      discovery,
      now: new Date(Date.parse(NOW) + REDSKILLED_QUEUE_STALENESS_MS + 1_000).toISOString(),
    });

    expect(isRedskilledQueueReport(fresh)).toBe(true);
    expect(fresh.stale).toBe(false);
    expect(fresh.age_ms).toBe(1_000);
    expect(old.stale).toBe(true);
  });

  it("calls nothing stale when nothing was ever polled", () => {
    const report = buildQueueReport({ discovery: null, now: NOW });
    expect(report.stale).toBe(false);
    expect(report.fetched_at).toBeNull();
    expect(report.projects).toEqual([]);
  });
});

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-queue-"));
  roots.push(root);
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

function registration(index: number) {
  return {
    project_label: `acme/p${index}`,
    selector: `repo:acme/p${index} label:ready-for-agent`,
    argv: ["red-skills-dev", "work"],
    workspace_path: `/tmp/acme/p${index}`,
    target: 1,
  };
}

describe("the daemon polls the queue of whatever is registered", () => {
  it("discovers every registered project in one request, and none when nothing is registered", async () => {
    const queries: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: {
        intervalMs: 0,
        transport: async (query) => {
          queries.push(query);
          return answer([2, 9]);
        },
      },
    });
    running.push(daemon);

    // Nothing registered: no request at all, and no depths invented for it.
    expect(await daemon.pollQueueDiscovery()).toBeNull();
    expect(daemon.queueDiscovery()).toBeNull();
    expect(queries).toHaveLength(0);

    daemon.registerProject(registration(0));
    daemon.registerProject(registration(1));
    const discovery = await daemon.pollQueueDiscovery();

    expect(queries).toHaveLength(1);
    expect(discovery!.request_count).toBe(1);
    expect(discovery!.projects.map((entry) => entry.project_label)).toEqual(["acme/p0", "acme/p1"]);
    expect(discovery!.projects.map((entry) => entry.depth)).toEqual([2, 9]);
    expect(daemon.queueDiscovery()).toEqual(discovery);
  });

  it("includes a project registered mid-flight from the next interval, never dropping it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: {
        intervalMs: 0,
        transport: async (query) => {
          call += 1;
          const aliases = query.match(/q\d+: search/g)?.length ?? 0;
          if (call === 1) await held;
          return answer(Array.from({ length: aliases }, (_, index) => index + 1));
        },
      },
    });
    running.push(daemon);

    daemon.registerProject(registration(0));
    const inFlight = daemon.pollQueueDiscovery();
    // The second project arrives while the first request is still out.
    daemon.registerProject(registration(1));
    release();
    const first = await inFlight;

    // Absent from an answer that never asked about it — not folded in late.
    expect(first!.projects.map((entry) => entry.project_label)).toEqual(["acme/p0"]);

    const second = await daemon.pollQueueDiscovery();
    expect(second!.projects.map((entry) => entry.project_label)).toEqual(["acme/p0", "acme/p1"]);
    expect(second!.request_count).toBe(1);
  });

  it("keeps the queue and activity cadences apart, each ticking on its own window", async () => {
    // Only the intervals are faked: the daemon's start still does real I/O, and
    // a fake clock over all of it would stall the bind rather than the timers.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let queueCalls = 0;
    let activityCalls = 0;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      repositoryActivity: {
        projects: [{ project_label: "acme/p0", owner: "acme", name: "p0" }],
        hostTokenRef: "host",
        intervalMs: 1_000,
        transport: async () => {
          activityCalls += 1;
          return { data: { rateLimit: { remaining: 4900, resetAt: null } } };
        },
      },
      queueDiscovery: {
        intervalMs: 100,
        transport: async () => {
          queueCalls += 1;
          return answer([3]);
        },
      },
    });
    running.push(daemon);
    daemon.registerProject(registration(0));

    // The activity poller fetches once at arming; the queue poller waits for its
    // first window, because its selectors arrive by registration.
    expect(activityCalls).toBe(1);
    expect(queueCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);

    // Ten fast windows against one slow one: two cadences, not one.
    expect(queueCalls).toBe(10);
    expect(activityCalls).toBe(2);
  });

  it("uses the balance-derived backoff instead of continuing on a fixed interval", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
    let queueCalls = 0;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      queueDiscovery: {
        intervalMs: 100,
        transport: async () => {
          queueCalls += 1;
          return answer([3], { remaining: 100, resetAt: null });
        },
      },
    });
    running.push(daemon);
    daemon.registerProject(registration(0));

    await vi.advanceTimersByTimeAsync(1_000);

    // The first answer asks the scheduler for a 30s low-balance cadence. A fixed
    // 100ms interval would have made ten calls in this same window.
    expect(queueCalls).toBe(1);
  });
});
