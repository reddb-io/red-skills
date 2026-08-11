// The daemon's hot poll path pays for a changed REST collection and revalidates
// an unchanged one for zero primary/search budget. A 304 must carry the prior
// value all the way to the daemon document; it is never an empty queue/count.
import { describe, expect, it } from "vitest";

import {
  createGitHubActivityTransport,
  fetchRepositoryActivity,
} from "../src/repository-activity.js";
import { fetchQueueDiscovery } from "../src/queue-discovery.js";

const FIRST = "2026-08-04T12:00:00.000Z";
const SECOND = "2026-08-04T12:00:15.000Z";

describe("the daemon's conditional REST poll path", () => {
  it("serves last-known panorama and queue values with their original instants on degradation", async () => {
    let failing = false;
    const transport = createGitHubActivityTransport({
      token: "test-token",
      endpoint: "https://tracker.example/graphql",
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        if (failing) throw new Error("tracker unavailable");
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/search/issues")) return json({ total_count: 4, items: [] });
        if (path.endsWith("/pulls")) return json([{ number: 1 }, { number: 2 }]);
        return json([{ number: 1, closed_at: "2026-08-04T11:00:00.000Z", labels: [] }]);
      },
    });
    const input = {
      projects: [{
        project_label: "acme/widgets",
        owner: "acme",
        name: "widgets",
        queue_labels: { ready: "ready-for-agent", human: "ready-for-human" },
      }],
      hostTokenRef: "host",
      transport,
    };
    const fresh = await fetchRepositoryActivity({ ...input, now: FIRST });
    failing = true;
    const degraded = await fetchRepositoryActivity({ ...input, now: SECOND, previous: fresh });

    expect(degraded.projects[0]!.counts).toEqual(fresh.projects[0]!.counts);
    expect(degraded.projects[0]!.panorama_fetched_at).toBe(FIRST);
    expect(degraded.projects[0]!.queue_fetched_at).toBe(FIRST);
    expect(degraded.projects[0]!.detail).toContain("serving last-known");
  });

  it("returns the held queue depth when GitHub answers 304", async () => {
    const headers: Headers[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const seen = new Headers(init?.headers);
      headers.push(seen);
      if (seen.get("if-none-match") === '"queue-v1"') {
        return new Response(null, { status: 304, headers: { etag: '"queue-v1"' } });
      }
      return new Response(JSON.stringify([
        { number: 1 },
        { number: 2 },
        { number: 3 },
        { number: 4 },
        { number: 5, pull_request: {} },
      ]), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"queue-v1"' },
      });
    };
    const transport = createGitHubActivityTransport({
      token: "test-token",
      endpoint: "https://tracker.example/graphql",
      fetchImpl,
      retryCount: 0,
      throttle: false,
    });
    const input = {
      projects: [{
        project_label: "acme/widgets",
        selector: "repo:acme/widgets is:issue is:open",
        poll: { owner: "acme", repo: "widgets", labels: ["ready-for-agent"] },
      }],
      transport,
    };

    const fresh = await fetchQueueDiscovery({ ...input, now: FIRST });
    const unchanged = await fetchQueueDiscovery({ ...input, now: SECOND });

    expect(fresh.projects[0]).toMatchObject({ outcome: "counted", depth: 4 });
    expect(unchanged.projects).toEqual(fresh.projects);
    expect(unchanged.request_count).toBe(1);
    expect(headers).toHaveLength(2);
    expect(headers[1]!.get("if-none-match")).toBe('"queue-v1"');
  });

  it("reuses every held activity count when all four panorama reads answer 304", async () => {
    const requests: Array<{ readonly path: string; readonly etag: string | null }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      const etag = new Headers(init?.headers).get("if-none-match");
      requests.push({ path, etag });
      const kind = path.endsWith("/search/issues")
        ? "merged"
        : path.endsWith("/pulls") ? "prs" : parsed.searchParams.get("state") === "open" ? "issues" : "closed";
      if (etag === `"${kind}-v1"`) {
        return new Response(null, { status: 304, headers: { etag } });
      }
      const count = kind === "prs" ? 2 : kind === "issues" ? 3 : kind === "merged" ? 4 : 5;
      if (kind === "merged") {
        return new Response(JSON.stringify({ total_count: count, items: [] }), {
          status: 200,
          headers: { "content-type": "application/json", etag: `"${kind}-v1"` },
        });
      }
      const items = Array.from({ length: count }, (_, index) => ({
        number: index + 1,
        ...(kind === "closed" ? { closed_at: "2026-08-04T11:00:00.000Z" } : {}),
      }));
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json", etag: `"${kind}-v1"` },
      });
    };
    const transport = createGitHubActivityTransport({
      token: "test-token",
      endpoint: "https://tracker.example/graphql",
      fetchImpl,
      retryCount: 0,
      throttle: false,
    });
    const input = {
      projects: [{ project_label: "acme/widgets", owner: "acme", name: "widgets" }],
      hostTokenRef: "host",
      transport,
    };

    const fresh = await fetchRepositoryActivity({ ...input, now: FIRST });
    const unchanged = await fetchRepositoryActivity({
      ...input,
      now: SECOND,
      previous: fresh,
      panoramaRefreshMs: 0,
    });

    expect(fresh.projects[0]).toMatchObject({
      outcome: "counted",
      counts: { open_pull_requests: 2, open_issues: 3, recently_closed: 5, merged_today: 4 },
    });
    expect(unchanged.projects[0]!.counts).toEqual(fresh.projects[0]!.counts);
    expect(unchanged.request_count).toBe(4);
    expect(requests).toHaveLength(8);
    expect(requests.slice(4).map((request) => request.etag)).toEqual([
      '"issues-v1"',
      '"prs-v1"',
      '"closed-v1"',
      '"merged-v1"',
    ]);
  });

  it("counts the ready and human queues off the open-Issue list it already paid for", async () => {
    const paths: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const parsed = new URL(String(url));
      paths.push(`${parsed.pathname}?${parsed.searchParams.get("state")}`);
      if (parsed.pathname.endsWith("/search/issues")) return json({ total_count: 3, items: [] });
      if (parsed.pathname.endsWith("/pulls")) {
        return json([{ number: 1 }, { number: 2 }]);
      }
      if (parsed.searchParams.get("state") === "closed") return json([]);
      return json([
        { number: 10, labels: [{ name: "ready-for-agent" }] },
        { number: 11, labels: [{ name: "ready-for-agent" }, { name: "type:spec" }] },
        { number: 12, labels: [{ name: "ready-for-human" }] },
        { number: 13, labels: [] },
        // A pull request answered by the Issues route is not an Issue, and it is
        // not a queue item either — the same filter the open count already uses.
        { number: 14, labels: [{ name: "ready-for-agent" }], pull_request: {} },
      ]);
    };
    const transport = createGitHubActivityTransport({
      token: "test-token",
      endpoint: "https://tracker.example/graphql",
      fetchImpl,
      retryCount: 0,
      throttle: false,
    });

    const activity = await fetchRepositoryActivity({
      projects: [{
        project_label: "acme/widgets",
        owner: "acme",
        name: "widgets",
        queue_labels: { ready: "ready-for-agent", human: "ready-for-human" },
      }],
      hostTokenRef: "host",
      transport,
      now: FIRST,
    });

    expect(activity.projects[0]).toMatchObject({
      outcome: "counted",
      counts: { open_pull_requests: 2, open_issues: 4, ready_queue: 2, human_queue: 1 },
    });
    // Four reads, with queue counters still a filter over the open-Issue bytes:
    // bytes this poll already holds, never two more label-filtered lists.
    expect(activity.request_count).toBe(4);
    expect(paths).toHaveLength(4);
  });

  it("leaves both queue counters absent when a project names no label", async () => {
    const transport = createGitHubActivityTransport({
      token: "test-token",
      endpoint: "https://tracker.example/graphql",
      fetchImpl: (async (url: string | URL | Request) => String(url).includes("/search/issues")
        ? json({ total_count: 0, items: [] })
        : json([{ number: 1, labels: [{ name: "ready-for-agent" }] }])) as unknown as typeof fetch,
      retryCount: 0,
      throttle: false,
    });

    const activity = await fetchRepositoryActivity({
      projects: [{ project_label: "acme/widgets", owner: "acme", name: "widgets" }],
      hostTokenRef: "host",
      transport,
      now: FIRST,
    });

    // The label is right there in the answer, and it is still not counted: a
    // project that named no label has an uncounted queue, not a drained one.
    expect(activity.projects[0]!.counts).toMatchObject({ ready_queue: null, human_queue: null });
  });

  it("refuses a project that names an empty label rather than counting nothing", async () => {
    await expect(fetchRepositoryActivity({
      projects: [{
        project_label: "acme/widgets",
        owner: "acme",
        name: "widgets",
        queue_labels: { ready: "", human: "ready-for-human" },
      }],
      hostTokenRef: "host",
      transport: (async () => ({})) as never,
      now: FIRST,
    })).rejects.toThrow(/empty queue label/);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
