import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRecords } from "@reddb-io/toon";
import { describe, expect, it } from "vitest";

import { createRspResidentGithubClient } from "../src/resident-github.js";
import { rewriteProxyCommandLine } from "../src/proxy.js";

const ISSUE_ARGS = ["issue", "view", "42"] as const;
const ISSUE_PATH = "repos/acme/widgets/issues/42";

describe("resident-owned GitHub reads", () => {
  it("keeps the ETag warm, routes the single object to REST, and attributes both calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsp-resident-github-"));
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

  it("never turns a classified read into a search fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsp-resident-github-"));
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

  it("routes a multi-node listing to GraphQL without falling into search", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsp-resident-github-"));
    const seen: string[] = [];
    const github = createRspResidentGithubClient({
      rootDir: root,
      token: "fixture-token",
      baseUrl: "https://github.invalid/api/v3",
      fetchImpl: async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({
          data: {
            repository: {
              issues: { nodes: [{ number: 42, title: "budget", state: "OPEN", labels: { nodes: [] } }] },
            },
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
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

    expect(result).toMatchObject({ status: 0, surface: "graphql", pool: "graphql" });
    expect(seen).toEqual(["https://github.invalid/api/graphql"]);
    expect(JSON.parse(result.stdout)).toMatchObject([{ number: 42, title: "budget", state: "open" }]);
  });

  it("returns a structured repair when GitHub refuses the budget", async () => {
    const root = await mkdtemp(join(tmpdir(), "rsp-resident-github-"));
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
});

describe("proxy mutation semantics", () => {
  it("leaves a write command byte-identical", () => {
    const command = "gh issue comment 42 --body 'ship it'";
    expect(rewriteProxyCommandLine(command)).toEqual({ commandLine: command, matches: [] });
  });
});
