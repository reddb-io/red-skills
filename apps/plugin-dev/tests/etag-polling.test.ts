// Compatibility coverage for the polling behaviours that outlived the Castle
// resident. Conditional transport is package-owned; cadence is daemon-owned.

import { describe, expect, it } from "vitest";
import {
  createGithubClient,
  githubRateLimitResetAt,
  isGithubRateLimitError,
  type GithubRequestFetch,
} from "@reddb-io/github";
import {
  activityRateLimitBackoffMs,
  REDSKILLED_ACTIVITY_RATE_LIMIT_MAX_BACKOFF_MS,
} from "../../redskilled/src/activity-cadence.js";
import { diffCheckRuns, snapshotCheckRuns } from "../src/core/etag-polling.js";

const REQUEST = {
  cacheKey: "checks:acme/widgets:abc123",
  route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
  parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
  operation: { key: "redskilled check-run poll", budget: "rest" as const },
};

describe("daemon-owned conditional polling compatibility", () => {
  it("retains ETag and server pacing headers, then reuses the held answer on 304", async () => {
    const seen: Headers[] = [];
    const responses = [
      new Response(JSON.stringify({ check_runs: [{ id: 9, name: "gate", status: "in_progress" }] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: '"checks-v1"',
          "x-poll-interval": "77",
        },
      }),
      new Response(null, {
        status: 304,
        headers: { etag: '"checks-v1"', "x-poll-interval": "90" },
      }),
    ];
    const fetchImpl: GithubRequestFetch = async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return responses.shift()!;
    };
    const client = createGithubClient({ token: "test-token", fetchImpl, retryCount: 0, throttle: false });

    const fresh = await client.conditionalRest<{ check_runs: Array<{ id: number }> }>(REQUEST);
    const unchanged = await client.conditionalRest<{ check_runs: Array<{ id: number }> }>(REQUEST);

    expect(fresh.headers.etag).toBe('"checks-v1"');
    expect(fresh.headers["x-poll-interval"]).toBe("77");
    expect(unchanged.headers["x-poll-interval"]).toBe("90");
    expect(unchanged.data).toEqual(fresh.data);
    expect(unchanged.quotaFree).toBe(true);
    expect(seen[0]!.get("if-none-match")).toBeNull();
    expect(seen[1]!.get("if-none-match")).toBe('"checks-v1"');
  });

  it("does not redeliver an unchanged event id across conditional cycles", async () => {
    const responses = [
      new Response(JSON.stringify([{ id: "9", type: "PullRequestEvent" }]), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"events-v1"' },
      }),
      new Response(null, { status: 304, headers: { etag: '"events-v1"' } }),
    ];
    const client = createGithubClient({
      token: "test-token",
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => responses.shift()!,
    });
    const delivered = new Set<string>();
    const request = { ...REQUEST, cacheKey: "events:acme/widgets", route: "GET /repos/{owner}/{repo}/events" };

    for (let cycle = 0; cycle < 2; cycle += 1) {
      const answer = await client.conditionalRest<Array<{ id: string }>>(request);
      if (!answer.quotaFree) for (const event of answer.data) delivered.add(event.id);
    }

    expect([...delivered]).toEqual(["9"]);
  });
});

describe("daemon polling cadence and fault compatibility", () => {
  const NOW_MS = Date.parse("2026-08-16T20:00:00.000Z");
  const FLOOR_MS = 60_000;

  it("prefers the primary reset instant and dates retry-after from the refusal", () => {
    expect(githubRateLimitResetAt({
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW_MS / 1_000 + 900) } },
    }, NOW_MS)).toBe("2026-08-16T20:15:00.000Z");
    expect(githubRateLimitResetAt({
      status: 429,
      response: { headers: { "retry-after": "240" } },
    }, NOW_MS)).toBe("2026-08-16T20:04:00.000Z");
  });

  it("bounds exhausted-pool backoff between the active cadence and the daemon cap", () => {
    expect(activityRateLimitBackoffMs({ exhausted: true, reset_at: "2026-08-16T19:59:00.000Z" }, FLOOR_MS, NOW_MS))
      .toBe(FLOOR_MS);
    expect(activityRateLimitBackoffMs({ exhausted: true, reset_at: "2026-08-17T20:00:00.000Z" }, FLOOR_MS, NOW_MS))
      .toBe(REDSKILLED_ACTIVITY_RATE_LIMIT_MAX_BACKOFF_MS);
    expect(activityRateLimitBackoffMs({ exhausted: true, reset_at: null }, FLOOR_MS, NOW_MS))
      .toBe(4 * FLOOR_MS);
  });

  it("keeps quota refusal distinct from a generic transport fault", () => {
    const quota = {
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1924992000" } },
    };
    expect(isGithubRateLimitError(quota)).toBe(true);
    expect(isGithubRateLimitError(new Error("connect ECONNREFUSED"))).toBe(false);
  });
});

describe("check-run snapshot compatibility", () => {
  it("emits one completion transition and no duplicate for an unchanged snapshot", () => {
    const before = snapshotCheckRuns({
      check_runs: [{ name: "gate", status: "in_progress", conclusion: null }],
    });
    const after = snapshotCheckRuns({
      check_runs: [{ name: "gate", status: "completed", conclusion: "success" }],
    });

    expect(diffCheckRuns(42, before, after)).toEqual([
      { event: "check_run", action: "completed", pr: 42, check: "gate", conclusion: "success" },
    ]);
    expect(diffCheckRuns(42, after, after)).toEqual([]);
  });
});
