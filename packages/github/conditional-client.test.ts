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
import type { GithubBalance } from "./balance.js";
import { githubSingleObjectCoalescingThreshold } from "./index.js";

const SEARCH_POLL: GithubAttributedOperation = {
  key: "redskilled queue poll",
  budget: "search",
};

const roots: string[] = [];

function balance(restRemaining: number, graphqlRemaining: number): GithubBalance {
  const reset = "2026-08-05T12:00:00.000Z";
  const pool = (name: "rest" | "graphql", remaining: number) => ({
    pool: name,
    resource: name === "rest" ? "core" : "graphql",
    limit: 5_000,
    remaining,
    used: 5_000 - remaining,
    reset_at: reset,
    fraction: remaining / 5_000,
  });
  return {
    version: 1,
    origin: "asked",
    outcome: "asked",
    source: "GET /rate_limit",
    asked_at: "2026-08-05T11:00:00.000Z",
    request_count: 1,
    pools: { rest: pool("rest", restRemaining), graphql: pool("graphql", graphqlRemaining), search: null },
    unreported_pools: ["search"],
    detail: "fixture",
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function ledgerPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "github-conditional-client-"));
  roots.push(root);
  return join(root, "spend.toonl");
}

describe("the conditional GitHub client", () => {
  it("publishes a threshold that rises with REST headroom relative to GraphQL", () => {
    expect(githubSingleObjectCoalescingThreshold(balance(4_000, 1_000))).toBe(4);
    expect(githubSingleObjectCoalescingThreshold(balance(500, 4_000))).toBe(1);
  });

  it("coalesces cold same-kind reads when REST pressure makes their live threshold one", async () => {
    const seen: Array<{ url: string; body: string }> = [];
    const fetchImpl: GithubRequestFetch = async (url, init) => {
      const body = String(init?.body ?? "");
      seen.push({ url: String(url), body });
      return new Response(JSON.stringify({
        data: {
          r0: { object: { number: 41, state: "OPEN" } },
          r1: { object: { number: 42, state: "CLOSED" } },
          rateLimit: { cost: 7 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const ledger = createGithubAttributionLedger({ path: await ledgerPath() });
    const client = createGithubClient({
      token: "test-token",
      fetchImpl,
      attribution: ledger,
      balance: () => balance(500, 4_000),
      retryCount: 0,
      throttle: false,
    });
    const read = (number: number) => client.singleObject<{ number: number; state: string }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number state",
      operation: { key: "issue view", budget: "rest" },
    });

    const answers = await Promise.all([read(41), read(42)]);

    expect(answers).toEqual([
      { data: { number: 41, state: "OPEN" }, surface: "graphql", quotaFree: false },
      { data: { number: 42, state: "CLOSED" }, surface: "graphql", quotaFree: false },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toContain("/graphql");
    expect(seen[0]!.body).toContain("r0: repository");
    expect(seen[0]!.body).toContain("r1: repository");
    const report = await ledger.report({
      from: "2000-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
      pool: "graphql",
    });
    expect(report).toMatchObject({ total_count: 1, total_cost: 7 });
  });

  it("keeps a burst at or below the live threshold on projected REST reads", async () => {
    const seen: string[] = [];
    const fetchImpl: GithubRequestFetch = async (url) => {
      seen.push(String(url));
      const number = Number(String(url).split("/").at(-1));
      return new Response(JSON.stringify({ number, state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = createGithubClient({
      token: "test-token",
      fetchImpl,
      balance: () => balance(4_000, 1_000),
      retryCount: 0,
      throttle: false,
    });
    const read = (number: number) => client.singleObject<{ number: number; state: string }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number state",
      operation: { key: "issue view", budget: "rest" },
      project: (value) => {
        const row = value as { number: number; state: string };
        return { number: row.number, state: row.state.toUpperCase() };
      },
    });

    const answers = await Promise.all([read(41), read(42)]);

    expect(answers.map(({ data }) => data)).toEqual([
      { number: 41, state: "OPEN" },
      { number: 42, state: "OPEN" },
    ]);
    expect(answers.every(({ surface }) => surface === "rest")).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it("keeps collecting same-kind reads while the authoritative balance is in flight", async () => {
    let releaseBalance!: (value: GithubBalance) => void;
    const pendingBalance = new Promise<GithubBalance>((resolve) => {
      releaseBalance = resolve;
    });
    const seen: string[] = [];
    const client = createGithubClient({
      token: "test-token",
      balance: () => pendingBalance,
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({
          data: {
            r0: { object: { number: 41 } },
            r1: { object: { number: 42 } },
            rateLimit: { cost: 2 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const read = (number: number) => client.singleObject<{ number: number }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number",
      operation: { key: "issue view", budget: "rest" },
    });

    const first = read(41);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = read(42);
    releaseBalance(balance(500, 4_000));
    const answers = await Promise.all([first, second]);

    expect(answers.map(({ surface }) => surface)).toEqual(["graphql", "graphql"]);
    expect(seen).toHaveLength(1);
  });

  it("treats a rejected balance ask as unknown and keeps later batches live", async () => {
    let asks = 0;
    const seen: string[] = [];
    const client = createGithubClient({
      token: "test-token",
      balance: () => {
        asks += 1;
        if (asks === 1) return Promise.reject(new Error("balance unavailable"));
        return balance(500, 4_000);
      },
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).endsWith("/graphql")) {
          return new Response(JSON.stringify({
            data: {
              r0: { object: { number: 43 } },
              r1: { object: { number: 44 } },
              rateLimit: { cost: 2 },
            },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const number = Number(String(url).split("/").at(-1));
        return new Response(JSON.stringify({ number }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const read = (number: number) => client.singleObject<{ number: number }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number",
      operation: { key: "issue view", budget: "rest" },
    });

    const first = Promise.all([read(41), read(42)]);
    const firstOutcome = await Promise.race([
      first.then((answers) => answers.map(({ surface }) => surface)),
      new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 100)),
    ]);
    expect(firstOutcome).toEqual(["rest", "rest"]);

    const second = await Promise.all([read(43), read(44)]);
    expect(second.map(({ surface }) => surface)).toEqual(["graphql", "graphql"]);
    expect(seen).toHaveLength(3);
  });

  it("refuses to invent a point cost when an aliased answer omits rateLimit cost", async () => {
    const ledger = createGithubAttributionLedger({ path: await ledgerPath() });
    const client = createGithubClient({
      token: "test-token",
      balance: () => balance(500, 4_000),
      attribution: ledger,
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => new Response(JSON.stringify({
        data: {
          r0: { object: { number: 41 } },
          r1: { object: { number: 42 } },
          rateLimit: {},
        },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    const read = (number: number) => client.singleObject<{ number: number }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number",
      operation: { key: "issue view", budget: "rest" },
    });

    const answers = await Promise.allSettled([read(41), read(42)]);

    expect(answers.every(({ status }) => status === "rejected")).toBe(true);
    expect(answers.map((answer) => answer.status === "rejected" ? String(answer.reason) : "")).toEqual([
      "Error: GitHub aliased query did not return a non-negative integer rateLimit.cost",
      "Error: GitHub aliased query did not return a non-negative integer rateLimit.cost",
    ]);
    const report = await ledger.report({
      from: "2000-01-01T00:00:00.000Z",
      to: "2100-01-01T00:00:00.000Z",
      pool: "graphql",
    });
    expect(report).toMatchObject({ total_count: 0, total_cost: 0 });
  });

  it("rejects every caller when malformed input cannot build an aliased query", async () => {
    const client = createGithubClient({
      token: "test-token",
      balance: () => balance(500, 4_000),
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => {
        throw new Error("malformed input must fail before transport");
      },
    });
    const read = (number: number) => client.singleObject<{ number: number }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "",
      operation: { key: "issue view", budget: "rest" },
    });

    const settled = Promise.allSettled([read(41), read(42)]);
    const outcome = await Promise.race([
      settled,
      new Promise<"wedged">((resolve) => setTimeout(() => resolve("wedged"), 100)),
    ]);

    expect(outcome).not.toBe("wedged");
    expect(outcome).toEqual([
      expect.objectContaining({ status: "rejected" }),
      expect.objectContaining({ status: "rejected" }),
    ]);
  });

  it("keeps warm conditional reads on REST even when the cold threshold would coalesce them", async () => {
    let currentBalance: GithubBalance | null = null;
    const seen: Array<{ url: string; etag: string | null }> = [];
    const fetchImpl: GithubRequestFetch = async (url, init) => {
      const number = String(url).split("/").at(-1)!;
      const etag = new Headers(init?.headers).get("if-none-match");
      seen.push({ url: String(url), etag });
      const validator = `"issue-${number}"`;
      if (etag === validator) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify({ number: Number(number), state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json", etag: validator },
      });
    };
    const client = createGithubClient({
      token: "test-token",
      fetchImpl,
      balance: () => currentBalance,
      retryCount: 0,
      throttle: false,
    });
    const read = (number: number) => client.singleObject<{ number: number }>({
      cacheKey: `issue:acme/widgets:${number}`,
      kind: "issue",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number",
      operation: { key: "issue view", budget: "rest" },
    });

    await read(41);
    await read(42);
    currentBalance = balance(500, 4_000);
    const unchanged = await Promise.all([read(41), read(42)]);

    expect(unchanged.every(({ surface, quotaFree }) => surface === "rest" && quotaFree)).toBe(true);
    expect(seen).toHaveLength(4);
    expect(seen.every(({ url }) => !url.includes("graphql"))).toBe(true);
    expect(seen.slice(2).map(({ etag }) => etag)).toEqual(['"issue-41"', '"issue-42"']);
  });

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
