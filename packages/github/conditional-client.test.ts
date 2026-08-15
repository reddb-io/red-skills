import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGithubAttributionLedger } from "./attribution.js";
import {
  createGithubClient,
  GithubPoolUnavailableError,
  githubRateLimitResetAt,
  isGithubRateLimitError,
  type GithubRequestFetch,
} from "./conditional-client.js";
import { GithubBackpressureError } from "./routing.js";
import type { GithubAttributedOperation } from "./attribution.js";
import type { GithubBalance } from "./balance.js";
import { githubSingleObjectCoalescingThreshold } from "./index.js";

const SEARCH_POLL: GithubAttributedOperation = {
  key: "redskilled queue poll",
  budget: "search",
};

const roots: string[] = [];

describe("rate-limit reset evidence", () => {
  it("reads the primary reset instant from a refused response", () => {
    expect(githubRateLimitResetAt({
      status: 403,
      response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1" } },
    }, 0)).toBe("1970-01-01T00:00:01.000Z");
  });

  it("dates a secondary-limit retry-after from the refusal instant", () => {
    expect(githubRateLimitResetAt({
      status: 429,
      response: { headers: { "retry-after": "60" } },
    }, 0)).toBe("1970-01-01T00:01:00.000Z");
  });

  it("keeps secondary throttling distinct from primary pool exhaustion", async () => {
    const client = createGithubClient({
      token: "test-token",
      now: () => "2026-08-15T21:00:00.000Z",
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => new Response(JSON.stringify({ message: "secondary rate limit" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "90", "x-ratelimit-remaining": "4999" },
      }),
    });

    const error = await client.graphql("query { viewer { login } }")
      .then(() => null, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(GithubBackpressureError);
    expect(error).not.toBeInstanceOf(GithubPoolUnavailableError);
    expect(error).toMatchObject({
      fact: {
        kind: "secondary-throttled",
        pool: "secondary",
        retry_at: "2026-08-15T21:01:30.000Z",
      },
    });
  });
});

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
  it("honors an explicit GraphQL rail while that pool has budget", async () => {
    const seen: string[] = [];
    const client = createGithubClient({
      token: "test-token",
      balance: () => balance(4_883, 5_000),
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({
          data: { r0: { object: { number: 7, headRefOid: "abc123" } }, rateLimit: { cost: 1 } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const answer = await client.singleObject<{ number: number; headRefOid: string }>({
      cacheKey: "pr:acme/widgets:7",
      kind: "pr",
      owner: "acme",
      repo: "widgets",
      number: 7,
      selection: "number headRefOid",
      operation: { key: "pr view", budget: "rest" },
      rail: "graphql",
    });

    expect(answer).toMatchObject({
      data: { number: 7, headRefOid: "abc123" },
      surface: "graphql",
      routing: { requestedRail: "graphql", selectedRail: "graphql", rerouted: false },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/graphql");
  });

  it("replays today's dry GraphQL incident on REST without issuing GraphQL", async () => {
    const seen: string[] = [];
    const client = createGithubClient({
      token: "test-token",
      balance: () => balance(4_883, 0),
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ number: 7, head: { sha: "abc123" }, state: "open" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const answer = await client.singleObject<{ number: number; head: { sha: string } }>({
      cacheKey: "pr:acme/widgets:7",
      kind: "pr",
      owner: "acme",
      repo: "widgets",
      number: 7,
      selection: "number headRefOid",
      operation: { key: "pr view", budget: "rest" },
      rail: "graphql",
    });

    expect(answer).toMatchObject({
      surface: "rest",
      routing: {
        requestedRail: "graphql",
        selectedRail: "rest",
        rerouted: true,
        pool: "graphql",
        resetAt: "2026-08-05T12:00:00.000Z",
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/pulls/7");
    expect(seen.every((url) => !url.includes("/graphql"))).toBe(true);
  });

  it("parks an operation with no equivalent by naming its pool and reset, with the gate ON", async () => {
    const client = createGithubClient({
      token: "test-token",
      budgetGate: "on",
      balance: () => balance(0, 4_883),
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => {
        throw new Error("a dry pool must be refused before transport");
      },
    });

    const error = await client.conditionalRest({
      cacheKey: "checks:acme/widgets:abc123",
      route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
      operation: { key: "pr checks", budget: "rest" },
    }).then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GithubPoolUnavailableError);
    expect(error).toMatchObject({ pool: "rest", resetAt: "2026-08-05T12:00:00.000Z" });
    expect(String(error)).toContain("rest pool");
    expect(String(error)).toContain("2026-08-05T12:00:00.000Z");
  });

  it("falls back to the last-known REST answer with its age before parking", async () => {
    let current = balance(4_883, 0);
    const instants = ["2026-08-05T11:00:00.000Z", "2026-08-05T11:00:30.000Z"];
    const client = createGithubClient({
      token: "test-token",
      budgetGate: "on",
      balance: () => current,
      now: () => instants.shift() ?? "2026-08-05T11:00:30.000Z",
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => new Response(JSON.stringify({ check_runs: [{ name: "gate", status: "completed" }] }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"checks-v1"' },
      }),
    });
    const request = {
      cacheKey: "checks:acme/widgets:abc123",
      route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
      operation: { key: "pr checks", budget: "rest" as const },
    };

    await client.conditionalRest(request);
    current = balance(0, 0);
    const cached = await client.conditionalRest(request);

    expect(cached).toMatchObject({
      data: { check_runs: [{ name: "gate", status: "completed" }] },
      quotaFree: true,
      degraded: {
        source: "cache",
        ageMs: 30_000,
        pool: "rest",
        resetAt: "2026-08-05T12:00:00.000Z",
      },
    });
  });

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
      budgetGate: "on",
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

describe("the balance watches; by default it stops nothing (#3768)", () => {
  it("issues a read a spent pool would have refused, because the gate is off", async () => {
    const seen: string[] = [];
    const client = createGithubClient({
      token: "test-token",
      // Spent on both rails: the gate, when on, refuses this before transport.
      balance: () => balance(0, 0),
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ check_runs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const answer = await client.conditionalRest({
      cacheKey: "checks:acme/widgets:abc123",
      route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
      operation: { key: "pr checks", budget: "rest" },
    });

    expect(answer.data).toEqual({ check_runs: [] });
    expect(seen).toHaveLength(1);
  });

  it("never waits on the balance it will not consult", async () => {
    let asked = 0;
    const client = createGithubClient({
      token: "test-token",
      // A provider that never settles: the wedge shape of #3768.
      balance: () => {
        asked += 1;
        return new Promise<never>(() => undefined);
      },
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => new Response(JSON.stringify({ check_runs: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    const startedAt = Date.now();
    const answer = await client.conditionalRest({
      cacheKey: "checks:acme/widgets:abc123",
      route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
      operation: { key: "pr checks", budget: "rest" },
    });

    expect(answer.data).toEqual({ check_runs: [] });
    expect(asked).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("bounds the balance a coalescing flush DOES consult, so one stall is not every read", async () => {
    const seen: string[] = [];
    const client = createGithubClient({
      token: "test-token",
      balanceTimeoutMs: 25,
      // The flush reads the balance to pick a rail; a stalled ask must degrade to
      // unknown rather than hold every joined read.
      balance: () => new Promise<never>(() => undefined),
      retryCount: 0,
      throttle: false,
      fetchImpl: async (url) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ number: 7, state: "open" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const read = (number: number) => client.singleObject<{ number: number }>({
      cacheKey: `pr:acme/widgets:${number}`,
      kind: "pr",
      owner: "acme",
      repo: "widgets",
      number,
      selection: "number",
      operation: { key: "pr view", budget: "rest" },
    });

    const startedAt = Date.now();
    const answers = await Promise.all([read(7), read(8)]);

    expect(answers.map(({ surface }) => surface)).toEqual(["rest", "rest"]);
    expect(seen).toHaveLength(2);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("still refuses a spent pool when the operator turned the gate on", async () => {
    const client = createGithubClient({
      token: "test-token",
      budgetGate: "on",
      balance: () => balance(0, 0),
      retryCount: 0,
      throttle: false,
      fetchImpl: async () => {
        throw new Error("a gated dry pool must be refused before transport");
      },
    });

    const error = await client.conditionalRest({
      cacheKey: "checks:acme/widgets:abc123",
      route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
      operation: { key: "pr checks", budget: "rest" },
    }).then(() => null, (thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GithubPoolUnavailableError);
  });

  it("times a read out loudly instead of hanging on a silent transport", async () => {
    const client = createGithubClient({
      token: "test-token",
      timeoutMs: 25,
      retryCount: 0,
      throttle: false,
      fetchImpl: () => new Promise<Response>(() => undefined),
    });

    const startedAt = Date.now();
    const error = await client.conditionalRest({
      cacheKey: "checks:acme/widgets:abc123",
      route: "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
      parameters: { owner: "acme", repo: "widgets", ref: "abc123" },
      operation: { key: "pr checks", budget: "rest" },
    }).then(() => null, (thrown: unknown) => thrown);

    expect(String(error)).toContain("deadline");
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  });
});

describe("a 404 is an answer, not a failure", () => {
  it.each([304, 400, 401, 403, 404, 410, 422, 429, 451])(
    "asks once when GitHub gives the definitive status %i",
    async (status) => {
      vi.useFakeTimers();
      let calls = 0;
      const client = createGithubClient({
        token: "test-token",
        retryCount: 3,
        throttle: false,
        fetchImpl: async () => {
          calls += 1;
          return new Response(status === 304 ? null : JSON.stringify({ message: "definitive answer" }), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      });

      const answer = client.conditionalRest({
        cacheKey: `definitive:${status}`,
        route: "GET /repos/{owner}/{repo}/contents/{path}",
        parameters: { owner: "acme", repo: "widgets", path: "CODEOWNERS" },
        operation: { key: "api rest", budget: "rest" },
      }).catch(() => undefined);
      await vi.runAllTimersAsync();
      await answer;
      vi.useRealTimers();

      expect(calls).toBe(1);
    },
    60_000,
  );

  it("asks once for an absent resource instead of retrying it", async () => {
    let calls = 0;
    const client = createGithubClient({
      token: "test-token",
      throttle: false,
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const error = await client.conditionalRest({
      cacheKey: "codeowners:acme/widgets:.github/CODEOWNERS",
      route: "GET /repos/{owner}/{repo}/contents/{path}",
      parameters: { owner: "acme", repo: "widgets", path: ".github/CODEOWNERS" },
      operation: { key: "api rest", budget: "rest" },
    }).then(() => null, (thrown: unknown) => thrown);

    expect((error as { status?: number }).status).toBe(404);
    // Retrying cost 93s of backoff per CODEOWNERS lookup and froze Worker boot.
    expect(calls).toBe(1);
  }, 60_000);
});
