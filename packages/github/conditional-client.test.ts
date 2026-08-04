import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGithubAttributionLedger } from "./attribution.js";
import {
  createGithubClient,
  isGithubRateLimitError,
  type GithubRequestFetch,
} from "./conditional-client.js";
import type { GithubAttributedOperation } from "./attribution.js";

const SEARCH_POLL: GithubAttributedOperation = {
  key: "redskilled queue poll",
  budget: "search",
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "github-conditional-client-"));
  roots.push(root);
  return join(root, "spend.toonl");
}

describe("the conditional GitHub client", () => {
  it("revalidates every page and joins held pages into the same collection", async () => {
    const seen: Array<{ readonly page: string | null; readonly etag: string | null }> = [];
    const fetchImpl: GithubRequestFetch = async (url, init) => {
      const page = new URL(String(url)).searchParams.get("page");
      const etag = new Headers(init?.headers).get("if-none-match");
      seen.push({ page, etag });
      const validator = `"page-${page}"`;
      if (etag === validator) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify([{ number: Number(page) }]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: validator,
          ...(page === "1"
            ? { link: '<https://api.github.com/repos/acme/widgets/issues?page=2>; rel="next"' }
            : {}),
        },
      });
    };
    const client = createGithubClient({ token: "test-token", fetchImpl, retryCount: 0, throttle: false });
    const request = {
      cacheKey: "queue:acme/widgets",
      route: "GET /repos/{owner}/{repo}/issues",
      parameters: { owner: "acme", repo: "widgets", state: "open" },
      operation: { key: "redskilled queue poll", budget: "rest" as const },
    };

    const fresh = await client.conditionalPaginate<{ number: number }>(request);
    const unchanged = await client.conditionalPaginate<{ number: number }>(request);

    expect(fresh).toMatchObject({ data: [{ number: 1 }, { number: 2 }], requestCount: 2 });
    expect(unchanged.data).toEqual(fresh.data);
    expect(seen).toEqual([
      { page: "1", etag: null },
      { page: "2", etag: null },
      { page: "1", etag: '"page-1"' },
      { page: "2", etag: '"page-2"' },
    ]);
  });

  it("revalidates with the stored ETag and returns the held answer on 304", async () => {
    const seen: Headers[] = [];
    const responses = [
      new Response(JSON.stringify({ total_count: 7, items: [] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"queue-v1"' },
      }),
      new Response(null, { status: 304, headers: { etag: '"queue-v1"' } }),
    ];
    const fetchImpl: GithubRequestFetch = async (_url, init) => {
      seen.push(new Headers(init?.headers));
      return responses.shift()!;
    };
    const ledger = createGithubAttributionLedger({ path: await ledgerPath() });
    const client = createGithubClient({
      token: "test-token",
      fetchImpl,
      attribution: ledger,
      retryCount: 0,
      throttle: false,
    });
    const request = {
      cacheKey: "queue:acme/widgets",
      route: "GET /search/issues" as const,
      parameters: { q: "repo:acme/widgets is:issue is:open", per_page: 1 },
      operation: SEARCH_POLL,
    };

    const fresh = await client.conditionalRest<{ total_count: number; items: unknown[] }>(request);
    const unchanged = await client.conditionalRest<{ total_count: number; items: unknown[] }>(request);

    expect(fresh.data).toEqual({ total_count: 7, items: [] });
    expect(unchanged.data).toEqual(fresh.data);
    expect(seen[0]!.get("if-none-match")).toBeNull();
    expect(seen[1]!.get("if-none-match")).toBe('"queue-v1"');

    const report = await ledger.report({
      from: "2000-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
      pool: "search",
    });
    expect(report.operations).toEqual([
      { operation_key: "redskilled queue poll", pool: "search", count: 2, cost: 1 },
    ]);
  });

  it("never turns a network failure into the held answer", async () => {
    let calls = 0;
    const fetchImpl: GithubRequestFetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ total_count: 3 }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"queue-v1"' },
        });
      }
      throw new Error("socket closed");
    };
    const client = createGithubClient({ token: "test-token", fetchImpl, retryCount: 0, throttle: false });
    const request = {
      cacheKey: "queue:acme/widgets",
      route: "GET /search/issues" as const,
      parameters: { q: "repo:acme/widgets", per_page: 1 },
      operation: SEARCH_POLL,
    };

    await client.conditionalRest(request);
    await expect(client.conditionalRest(request)).rejects.toThrow("socket closed");
  });

  it("keeps a rate-limit refusal distinct from an unchanged response", async () => {
    const fetchImpl: GithubRequestFetch = async () =>
      new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1924992000",
        },
      });
    const client = createGithubClient({ token: "test-token", fetchImpl, retryCount: 0, throttle: false });

    const error = await client
      .conditionalRest({
        cacheKey: "queue:acme/widgets",
        route: "GET /search/issues",
        parameters: { q: "repo:acme/widgets", per_page: 1 },
        operation: SEARCH_POLL,
      })
      .then(() => null, (thrown: unknown) => thrown);

    expect(isGithubRateLimitError(error)).toBe(true);
  });
});
