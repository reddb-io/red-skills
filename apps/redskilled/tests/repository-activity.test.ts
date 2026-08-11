// The daemon serves repository activity for every registered project in ONE
// aliased query per interval (ADR 0130 Amendment 1). It stores counts without
// interpreting them, dates them inside the payload, refuses a project that wants
// its own credential, and never lets a spent quota or an unreachable repository
// read as a zero.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  readRedskilledStatuslinePayload,
  readRedskilledStatuslineString,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { isRedskilledStatuslinePayload } from "../src/statusline-payload.js";
import {
  buildActivityReport,
  isRedskilledActivityReport,
  REDSKILLED_ACTIVITY_STALENESS_MS,
} from "../src/activity-report.js";
import {
  assertOneHostToken,
  buildRepositoryActivityQuery,
  createGitHubActivityTransport,
  emptyRepositoryActivity,
  fetchRepositoryActivity,
  parseRepositoryActivityResponse,
  RedskilledSplitCredentialError,
  type RedskilledProjectRepository,
} from "../src/repository-activity.js";

const NOW = "2026-07-30T12:00:00.000Z";

function project(index: number, overrides: Partial<RedskilledProjectRepository> = {}): RedskilledProjectRepository {
  return { project_label: `acme/p${index}`, owner: "acme", name: `p${index}`, ...overrides };
}

function answer(
  projects: readonly RedskilledProjectRepository[],
  counts: readonly [number, number, number][],
  rateLimit: Record<string, unknown> = {},
) {
  const data: Record<string, unknown> = {
    // GitHub charges a query by the nodes it returns, so the fixture's cost grows
    // with the alias count exactly as the real answer's does. A fixture that
    // returned a constant here would be the test asserting the false half of
    // "flat in requests, flat in points".
    rateLimit: {
      remaining: 4900,
      resetAt: "2026-07-30T13:00:00.000Z",
      cost: projects.length + 1,
      ...rateLimit,
    },
  };
  projects.forEach((_, index) => {
    const [prs, issues, closed] = counts[index]!;
    data[`r${index}`] = {
      nameWithOwner: `acme/p${index}`,
      open_pull_requests: { totalCount: prs },
      open_issues: { totalCount: issues },
    };
    data[`c${index}`] = { issueCount: closed };
    data[`m${index}`] = { issueCount: 0 };
  });
  return { data };
}

describe("one request per interval, whatever the project count", () => {
  it("spans every registered repository in a single aliased query", () => {
    const projects = [project(0), project(1), project(2)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });

    expect(operation.aliases).toHaveLength(3);
    expect(operation.query.match(/query /g)).toHaveLength(1);
    for (let index = 0; index < projects.length; index += 1) {
      expect(operation.query).toContain(`r${index}: repository(owner: "acme", name: "p${index}")`);
      expect(operation.query).toContain(`c${index}: search(`);
      expect(operation.query).toContain(`m${index}: search(`);
      expect(operation.query).toContain("is:pr is:merged merged:>=2026-07-30");
    }
  });

  it("costs one transport call for twenty projects", async () => {
    const projects = Array.from({ length: 20 }, (_, index) => project(index));
    const queries: string[] = [];
    const activity = await fetchRepositoryActivity({
      projects,
      hostTokenRef: "host",
      now: NOW,
      transport: async (query) => {
        queries.push(query);
        return answer(projects, projects.map(() => [1, 2, 3] as [number, number, number]));
      },
    });

    expect(queries).toHaveLength(1);
    expect(activity.request_count).toBe(1);
    expect(activity.project_count).toBe(20);
    expect(activity.projects.every((entry) => entry.outcome === "counted")).toBe(true);
  });

  it("is flat in REQUESTS and says so in points, which are not flat", async () => {
    const fetch = async (count: number) => {
      const projects = Array.from({ length: count }, (_, index) => project(index));
      return await fetchRepositoryActivity({
        projects,
        hostTokenRef: "host",
        now: NOW,
        transport: async () => answer(projects, projects.map(() => [1, 2, 3] as [number, number, number])),
      });
    };

    const one = await fetch(1);
    const twenty = await fetch(20);

    // One request either way — that is the whole point of the aliased query.
    expect(one.request_count).toBe(twenty.request_count);
    expect(twenty.request_count).toBe(1);
    // And the node points GitHub charged are NOT the same number, which is the
    // half ADR 0130's "flat in the number of projects" left unsaid.
    expect(twenty.rate_limit.point_cost).toBeGreaterThan(one.rate_limit.point_cost!);
  });

  it("asks GitHub what the query cost rather than assuming it", async () => {
    const projects = [project(0), project(1)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });

    expect(operation.query).toContain("rateLimit { cost remaining resetAt }");

    const charged = parseRepositoryActivityResponse(
      operation,
      answer(projects, [[1, 2, 3], [4, 5, 6]], { cost: 47 }),
      { fetchedAt: NOW },
    );
    const silent = parseRepositoryActivityResponse(
      operation,
      { data: { rateLimit: { remaining: 10, resetAt: null } } },
      { fetchedAt: NOW },
    );

    expect(charged.rate_limit.point_cost).toBe(47);
    // An answer that did not say is an absence, never a free query.
    expect(silent.rate_limit.point_cost).toBeNull();
  });

  it("has nothing to fetch, and no request to spend, when nothing is registered", async () => {
    let calls = 0;
    const activity = await fetchRepositoryActivity({
      projects: [],
      hostTokenRef: "host",
      now: NOW,
      transport: async () => {
        calls += 1;
        return {};
      },
    });

    expect(calls).toBe(0);
    expect(activity).toEqual(emptyRepositoryActivity(NOW));
  });
});

describe("counts are stored and returned, never interpreted", () => {
  it("echoes the three integers and the repository it registered", () => {
    const projects = [project(0), project(1)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });
    const activity = parseRepositoryActivityResponse(operation, answer(projects, [[7, 3, 11], [0, 0, 0]]), {
      fetchedAt: NOW,
    });

    expect(activity.projects[0]).toMatchObject({
      project_label: "acme/p0",
      repository: "acme/p0",
      outcome: "counted",
      counts: { open_pull_requests: 7, open_issues: 3, recently_closed: 11, merged_today: 0 },
    });
    // A genuinely empty tracker IS a zero — this is the only outcome that carries one.
    // The queue counters stay null even here: the aliased query asked for no
    // label breakdown, so nothing counted them and nothing may read as drained.
    expect(activity.projects[1]!.counts).toEqual({
      open_pull_requests: 0,
      open_issues: 0,
      recently_closed: 0,
      merged_today: 0,
      ready_queue: null,
      human_queue: null,
    });
  });

  it("counts recently closed work from the window the query stated", () => {
    const operation = buildRepositoryActivityQuery([project(0)], { now: NOW, closedWindowMs: 24 * 60 * 60 * 1000 });

    expect(operation.closed_since).toBe("2026-07-29T12:00:00.000Z");
    expect(operation.query).toContain("closed:>=2026-07-29T12:00:00.000Z");
  });
});

describe("staleness travels inside the payload", () => {
  it("dates every project's counts so a consumer renders the age", () => {
    const projects = [project(0)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });
    const activity = parseRepositoryActivityResponse(operation, answer(projects, [[1, 2, 3]]), { fetchedAt: NOW });

    const report = buildActivityReport({ activity, now: "2026-07-30T12:00:05.000Z" });

    expect(report.age_ms).toBe(5_000);
    expect(report.stale).toBe(false);
    expect(report.threshold_ms).toBe(REDSKILLED_ACTIVITY_STALENESS_MS);
    expect(report.projects[0]!.age_ms).toBe(5_000);
    expect(report.projects[0]!.fetched_at).toBe(NOW);
    expect(report.reason).toContain("5000ms ago");
    expect(isRedskilledActivityReport(report)).toBe(true);
  });

  it("calls counts stale rather than presenting them as current", () => {
    const projects = [project(0)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });
    const activity = parseRepositoryActivityResponse(operation, answer(projects, [[1, 2, 3]]), { fetchedAt: NOW });

    const report = buildActivityReport({ activity, now: "2026-07-30T12:10:00.000Z" });

    expect(report.stale).toBe(true);
    expect(report.projects[0]!.stale).toBe(true);
    expect(report.reason).toContain("past the");
  });

  it("is not stale when the daemon polls nothing", () => {
    const report = buildActivityReport({ activity: null, now: NOW });

    expect(report.stale).toBe(false);
    expect(report.fetched_at).toBeNull();
    expect(report.projects).toEqual([]);
  });
});

describe("an unreachable repository fails loudly", () => {
  it("reports no counts rather than zero counts, and leaves its neighbours counted", () => {
    const projects = [project(0), project(1)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });
    const payload = {
      data: {
        rateLimit: { remaining: 4900, resetAt: "2026-07-30T13:00:00.000Z" },
        r0: { nameWithOwner: "acme/p0", open_pull_requests: { totalCount: 2 }, open_issues: { totalCount: 5 } },
        c0: { issueCount: 1 },
        m0: { issueCount: 0 },
        r1: null,
        c1: null,
        m1: null,
      },
      errors: [{ type: "NOT_FOUND", path: ["r1"], message: "Could not resolve to a Repository with the name 'acme/p1'." }],
    };

    const activity = parseRepositoryActivityResponse(operation, payload, { fetchedAt: NOW });

    expect(activity.projects[0]!.outcome).toBe("counted");
    expect(activity.projects[1]!.outcome).toBe("unreachable");
    expect(activity.projects[1]!.counts).toBeNull();
    expect(activity.projects[1]!.detail).toContain("not reachable with the host token");
  });

  it("does not turn a thrown transport into zeros", async () => {
    const activity = await fetchRepositoryActivity({
      projects: [project(0)],
      hostTokenRef: "host",
      now: NOW,
      transport: async () => {
        throw new Error("socket hang up");
      },
    });

    expect(activity.projects[0]!.outcome).toBe("unreachable");
    expect(activity.projects[0]!.counts).toBeNull();
    expect(activity.projects[0]!.detail).toContain("socket hang up");
  });
});

describe("a rate-limited fetch is not an empty one", () => {
  it("separates a spent quota from a legitimately empty tracker", () => {
    const projects = [project(0)];
    const operation = buildRepositoryActivityQuery(projects, { now: NOW });
    const payload = {
      data: { rateLimit: { remaining: 0, resetAt: "2026-07-30T13:00:00.000Z" }, r0: null, c0: null, m0: null },
      errors: [{ type: "RATE_LIMITED", path: ["r0"], message: "API rate limit exceeded" }],
    };

    const activity = parseRepositoryActivityResponse(operation, payload, { fetchedAt: NOW });

    expect(activity.rate_limit).toEqual({
      remaining: 0,
      reset_at: "2026-07-30T13:00:00.000Z",
      exhausted: true,
      point_cost: null,
    });
    expect(activity.projects[0]!.outcome).toBe("rate-limited");
    expect(activity.projects[0]!.counts).toBeNull();
    expect(activity.projects[0]!.detail).toContain("quota");
  });

  it("reads a refused HTTP response as a spent quota rather than an empty body", async () => {
    const transport = createGitHubActivityTransport({
      token: "t",
      fetchImpl: (async () =>
        new Response("", { status: 429, headers: { "x-ratelimit-remaining": "0" } })) as unknown as typeof fetch,
    });

    const activity = await fetchRepositoryActivity({
      projects: [project(0)],
      hostTokenRef: "host",
      now: NOW,
      transport,
    });

    expect(activity.projects[0]!.outcome).toBe("rate-limited");
    expect(activity.projects[0]!.counts).toBeNull();
    expect(activity.rate_limit.exhausted).toBe(true);
  });

  it("sends the query to the endpoint under the host token", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const transport = createGitHubActivityTransport({
      token: "host-token",
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(JSON.stringify({ data: {} }), { status: 200 });
      }) as unknown as typeof fetch,
    });

    await transport("query X { a }");

    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.github.com/graphql");
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe("token host-token");
  });
});

describe("every repository on the host shares one token", () => {
  it("refuses a project that declares its own credential", () => {
    const projects = [project(0), project(1, { token_ref: "its-own" })];

    expect(() => assertOneHostToken(projects, "host")).toThrow(RedskilledSplitCredentialError);
    expect(() => assertOneHostToken(projects, "host")).toThrow(/invalidates the host-scoped poller/);
  });

  it("accepts a project that names the host's own credential", () => {
    expect(() => assertOneHostToken([project(0, { token_ref: "host" })], "host")).not.toThrow();
  });

  it("refuses before it spends a request", async () => {
    let calls = 0;
    await expect(
      fetchRepositoryActivity({
        projects: [project(0, { token_ref: "its-own" })],
        hostTokenRef: "host",
        now: NOW,
        transport: async () => {
          calls += 1;
          return {};
        },
      }),
    ).rejects.toThrow(RedskilledSplitCredentialError);
    expect(calls).toBe(0);
  });

  it("refuses a project registered twice, rather than counting it twice", () => {
    expect(() => buildRepositoryActivityQuery([project(0), project(0)], { now: NOW })).toThrow(/registered twice/);
  });
});

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-activity-"));
  roots.push(root);
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

describe("the daemon serves the counts it polled", () => {
  it("serves repeated socket and consumer reads from cache while only its poll tick reaches GitHub", async () => {
    const projects = [project(0)];
    const requests: string[] = [];
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      ceiling: UNBOUNDED_HOST_CEILING,
      idleMs: 60_000,
      sampleMs: 0,
      clock: () => NOW,
      repositoryActivity: {
        projects,
        hostTokenRef: "host",
        // The test drives the daemon's own cycle explicitly. A timer firing here
        // would be another poll tick, not a request path, and would blur the seam.
        intervalMs: 0,
        transport: async (query) => {
          requests.push(query);
          return answer(projects, [[4, 9, 2]]);
        },
      },
    });
    running.push(daemon);

    for (let index = 0; index < 5; index += 1) {
      const payload = await readRedskilledStatuslinePayload(paths, {
        sessionProject: "acme/p0",
      });
      const rendered = await readRedskilledStatuslineString(paths, undefined, {
        sessionProject: "acme/p0",
      });
      expect(payload.repository_activity.projects).toEqual([]);
      expect(rendered.generated_at).toBe(NOW);
    }

    // A request-driven fetch would make this non-zero. The explicit cycle below
    // is the positive control: the same recorder sees exactly the daemon's poll.
    expect(requests).toHaveLength(0);

    await daemon.pollRepositoryActivity();

    expect(requests).toHaveLength(1);
    const cached = await readRedskilledStatuslinePayload(paths, {
      sessionProject: "acme/p0",
    });
    expect(requests).toHaveLength(1);
    expect(cached.repository_activity.projects[0]).toMatchObject({
      project_label: "acme/p0",
      fetched_at: NOW,
      age_ms: 0,
      counts: { open_pull_requests: 4, open_issues: 9 },
    });
  });

  it("carries every registered project's counts, dated, on the statusline payload", async () => {
    const projects = [project(0), project(1)];
    let calls = 0;
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
      repositoryActivity: {
        projects,
        hostTokenRef: "host",
        intervalMs: 0,
        transport: async () => {
          calls += 1;
          return answer(projects, [[4, 9, 2], [0, 1, 0]]);
        },
      },
    });
    running.push(daemon);

    // Nothing polled yet: the payload is honestly empty rather than zeroed.
    expect(daemon.statuslinePayload().repository_activity.projects).toEqual([]);

    await daemon.pollRepositoryActivity();
    const payload = daemon.statuslinePayload();

    expect(calls).toBe(1);
    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
    expect(payload.repository_activity.request_count).toBe(1);
    expect(payload.repository_activity.projects.map((entry) => entry.project_label)).toEqual(["acme/p0", "acme/p1"]);
    expect(payload.repository_activity.projects[0]!.counts).toEqual({
      open_pull_requests: 4,
      open_issues: 9,
      merged_today: 0,
      recently_closed: 2,
      ready_queue: null,
      human_queue: null,
    });
    expect(payload.repository_activity.projects[0]!.age_ms).not.toBeNull();
    expect(payload.repository_activity.age_ms).not.toBeNull();
  });

  it("polls nothing, and carries no counts, when no repository is registered", async () => {
    const daemon = await startRedskilledDaemon({
      paths: await sessionPaths(),
      ceiling: UNBOUNDED_HOST_CEILING,
      sampleMs: 0,
    });
    running.push(daemon);

    expect(await daemon.pollRepositoryActivity()).toBeNull();
    const report = daemon.statuslinePayload().repository_activity;
    expect(report.projects).toEqual([]);
    expect(report.stale).toBe(false);
    expect(report.fetched_at).toBeNull();
  });

  it("refuses to start at all when a project wants its own credential", async () => {
    await expect(
      startRedskilledDaemon({
        paths: await sessionPaths(),
        ceiling: UNBOUNDED_HOST_CEILING,
        sampleMs: 0,
        repositoryActivity: {
          projects: [project(0), project(1, { token_ref: "its-own" })],
          hostTokenRef: "host",
          intervalMs: 0,
          transport: async () => ({}),
        },
      }),
    ).rejects.toThrow(RedskilledSplitCredentialError);
  });
});
