import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubBalance } from "@reddb-io/github";

import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/config.js";
import { ResidentRspElisionStore, resolveResidentPaths } from "../src/resident-client.js";
import { createRspResidentGithubClient } from "../src/resident-github.js";
import { runResidentServer } from "../src/resident-server.js";
import { rewriteProxyCommandLine } from "../src/proxy.js";
import { shutdownResident, waitForResident } from "./telemetry.helpers.js";

const ISSUE_ARGS = ["issue", "view", "42"] as const;
const ISSUE_PATH = "repos/acme/widgets/issues/42";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-resident-github-"));
  roots.push(root);
  return root;
}

function pressuredBalance(): GithubBalance {
  const pool = (name: "rest" | "graphql", remaining: number) => ({
    pool: name,
    resource: name === "rest" ? "core" : "graphql",
    limit: 5_000,
    remaining,
    used: 5_000 - remaining,
    reset_at: "2026-08-05T12:00:00.000Z",
    fraction: remaining / 5_000,
  });
  return {
    version: 1,
    origin: "asked",
    outcome: "asked",
    source: "GET /rate_limit",
    asked_at: "2026-08-05T11:00:00.000Z",
    request_count: 1,
    pools: { rest: pool("rest", 500), graphql: pool("graphql", 4_000), search: null },
    unreported_pools: ["search"],
    detail: "fixture",
  };
}

describe("resident-owned GitHub reads", () => {
  it("coalesces concurrent cold issue views at the live resident boundary", async () => {
    const root = await tempRoot();
    const seen: string[] = [];
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      baseUrl: "https://github.invalid/api/v3",
      balance: () => pressuredBalance(),
      retryCount: 0,
      throttle: false,
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({
          data: {
            r0: { object: { number: 41, state: "OPEN" } },
            r1: { object: { number: 42, state: "CLOSED" } },
            rateLimit: { cost: 2 },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });

    const answers = await Promise.all([
      github.read({ args: ["issue", "view", "41"], path: "repos/acme/widgets/issues/41", actor: "worker-a" }),
      github.read({ args: ["issue", "view", "42"], path: "repos/acme/widgets/issues/42", actor: "worker-b" }),
    ]);

    expect(answers.map(({ surface }) => surface)).toEqual(["graphql", "graphql"]);
    expect(answers.map(({ stdout }) => JSON.parse(stdout).number)).toEqual([41, 42]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("/graphql");
  });

  it("keeps the ETag warm, routes the single object to REST, and attributes both calls", async () => {
    const root = await tempRoot();
    const seen: Array<{ url: string; etag: string | null }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const etag = new Headers(init?.headers).get("if-none-match");
      seen.push({ url, etag });
      if (etag === '"issue-v1"') {
        return new Response(null, { status: 304, headers: { etag } });
      }
      return new Response(JSON.stringify({ number: 42, state: "open" }), {
        status: 200,
        headers: { "content-type": "application/json", etag: '"issue-v1"' },
      });
    };
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      baseUrl: "https://github.invalid/api/v3",
      fetchImpl,
      retryCount: 0,
      throttle: false,
    });

    const first = await github.read({
      args: ISSUE_ARGS,
      path: ISSUE_PATH,
      actor: "session",
    });
    const second = await github.read({
      args: ISSUE_ARGS,
      path: ISSUE_PATH,
      actor: "proxied-agent:worker-7",
    });

    expect(first).toMatchObject({ status: 0, quotaFree: false, surface: "rest" });
    expect(second).toMatchObject({ status: 0, quotaFree: true, surface: "rest" });
    expect(seen).toEqual([
      { url: "https://github.invalid/api/v3/repos/acme/widgets/issues/42", etag: null },
      { url: "https://github.invalid/api/v3/repos/acme/widgets/issues/42", etag: '"issue-v1"' },
    ]);

    const ledger = await readFile(join(root, ".red", "state", "rsp", "github", "spend.toonl"), "utf8");
    expect(parseRecords(ledger)).toMatchObject([
      { operation_key: "issue view", pool: "rest", actor: "session", cost: 1 },
      { operation_key: "issue view", pool: "rest", actor: "proxied-agent:worker-7", cost: 0 },
    ]);
  });

  it("makes repeated Actions job observations quota-free when the job is unchanged", async () => {
    const root = await tempRoot();
    const seenEtags: Array<string | null> = [];
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      baseUrl: "https://github.invalid/api/v3",
      retryCount: 0,
      throttle: false,
      fetchImpl: async (_input, init) => {
        const etag = new Headers(init?.headers).get("if-none-match");
        seenEtags.push(etag);
        return etag === '"job-v1"'
          ? new Response(null, { status: 304, headers: { etag } })
          : new Response(JSON.stringify({ id: 93918599356, status: "in_progress", conclusion: null }), {
              status: 200,
              headers: { "content-type": "application/json", etag: '"job-v1"' },
            });
      },
    });
    const request = {
      args: ["run", "view", "93918599356"],
      path: "repos/reddb-io/red-dev/actions/jobs/93918599356",
      actor: "session",
    } as const;

    const first = await github.read(request);
    const unchanged = await github.read(request);

    expect(first).toMatchObject({ status: 0, quotaFree: false, pool: "rest" });
    expect(unchanged).toMatchObject({ status: 0, quotaFree: true, pool: "rest" });
    expect(unchanged.stdout).toBe(first.stdout);
    expect(seenEtags).toEqual([null, '"job-v1"']);
  });

  it("never turns a classified read into a search fallback", async () => {
    const root = await tempRoot();
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      fetchImpl: async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
      retryCount: 0,
      throttle: false,
    });

    const result = await github.read({ args: ["issue", "list", "--search", "bug"], path: ISSUE_PATH, actor: "session" });
    expect(result).toMatchObject({ status: 75, refused: true, pool: "search" });
    expect(result.stderr).toContain("search reads are never a fallback");
  });

  it("routes a stable-poll listing to REST (volatility first), never search", async () => {
    const root = await tempRoot();
    const seen: string[] = [];
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      baseUrl: "https://github.invalid/api/v3",
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify(
          [{ number: 42, title: "budget", state: "open", labels: [] }],
        ), { status: 200, headers: { "content-type": "application/json" } });
      },
      retryCount: 0,
      throttle: false,
    });

    const result = await github.read({
      args: ["issue", "list"],
      path: "repos/acme/widgets/issues",
      params: { owner: "acme", repo: "widgets" },
      actor: "session",
    });

    expect(result).toMatchObject({ status: 0, surface: "rest", pool: "rest" });
    expect(seen[0]).toContain("/repos/acme/widgets/issues");
    expect(JSON.parse(result.stdout)).toMatchObject([{ number: 42, title: "budget", state: "open" }]);
  });

  it("returns a structured repair when GitHub refuses the budget", async () => {
    const root = await tempRoot();
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      fetchImpl: async () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
        status: 403,
        headers: { "content-type": "application/json", "x-ratelimit-remaining": "0" },
      }),
      retryCount: 0,
      throttle: false,
    });

    const result = await github.read({ args: ISSUE_ARGS, path: ISSUE_PATH, actor: "session" });
    expect(result).toMatchObject({ status: 75, refused: true, pool: "rest" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      refused: true,
      reason: "github-budget-refused",
      repair: "wait for the reported GitHub rate-limit reset, then retry",
    });
  });

  it("serves separate clients through one resident-lifetime ETag store", async () => {
    const root = await tempRoot();
    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      retryCount: 0,
      throttle: false,
      fetchImpl: async (_input, init) => {
        const etag = new Headers(init?.headers).get("if-none-match");
        return etag === '"wire-v1"'
          ? new Response(null, { status: 304, headers: { etag } })
          : new Response('{"number":42}', {
              status: 200,
              headers: { "content-type": "application/json", etag: '"wire-v1"' },
            });
      },
    });
    const server = runResidentServer({
      socketPath: paths.socketPath,
      rootDir: paths.rootDir,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      idleMs: 30_000,
      github,
    });
    await waitForResident(paths.socketPath, 20_000);
    const config = { storeUri, ttlDays: DEFAULT_RSP_TTL_DAYS, byteBudget: DEFAULT_RSP_BYTE_BUDGET };

    try {
      const firstClient = new ResidentRspElisionStore(paths, config, { ensureResident: false });
      const secondClient = new ResidentRspElisionStore(paths, config, { ensureResident: false });
      const first = await firstClient.githubRead({ args: ISSUE_ARGS, path: ISSUE_PATH, actor: "session" });
      const second = await secondClient.githubRead({ args: ISSUE_ARGS, path: ISSUE_PATH, actor: "session" });
      expect(first.quotaFree).toBe(false);
      expect(second.quotaFree).toBe(true);
    } finally {
      await shutdownResident(paths.socketPath);
      await server;
    }
  }, 60_000);
});

describe("proxy mutation semantics", () => {
  it("leaves a write command byte-identical", () => {
    const command = "gh issue comment 42 --body 'ship it'";
    expect(rewriteProxyCommandLine(command)).toEqual({ commandLine: command, matches: [] });
  });
});
