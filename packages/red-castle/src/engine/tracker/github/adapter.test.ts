import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GithubClient } from "@reddb-io/github";
import { createGitHubTrackerAdapter, type GhExec } from "./adapter.js";

function githubStub(
  answer: (request: Parameters<GithubClient["conditionalRest"]>[0]) => unknown,
): Pick<GithubClient, "conditionalRest"> {
  return {
    async conditionalRest<T>(
      request: Parameters<GithubClient["conditionalRest"]>[0],
    ) {
      return { data: answer(request) as T, headers: {}, quotaFree: false };
    },
  };
}

describe("GitHub tracker adapter", () => {
  it("reads one issue through the shared conditional REST client", async () => {
    const ghCalls: string[][] = [];
    const requests: Parameters<GithubClient["conditionalRest"]>[0][] = [];
    const tracker = createGitHubTrackerAdapter({
      repo: "owner/repo",
      gh: async (args) => {
        ghCalls.push([...args]);
        throw new Error("single-object reads must not reach gh");
      },
      github: githubStub((request) => {
        requests.push(request);
        return { state: "closed" };
      }),
    });

    await expect(tracker.isIssueClosed(7)).resolves.toBe(true);
    expect(ghCalls).toEqual([]);
    expect(requests).toEqual([
      expect.objectContaining({
        cacheKey: "red-castle:issue:owner/repo:7:state",
        route: "GET /repos/{owner}/{repo}/issues/{issue_number}",
        parameters: { owner: "owner", repo: "repo", issue_number: 7 },
        operation: { key: "issue view", budget: "rest" },
      }),
    ]);
  });

  it("lists open issues through conditional REST", async () => {
    const ghCalls: string[][] = [];
    const requests: Parameters<GithubClient["conditionalRest"]>[0][] = [];
    const tracker = createGitHubTrackerAdapter({
      repo: "owner/repo",
      gh: async (args) => {
        ghCalls.push([...args]);
        throw new Error("issue lists must not reach gh");
      },
      github: githubStub((request) => {
        requests.push(request);
        return [
          {
            number: 12,
            body: "Body",
            labels: [{ name: "wait:dependency" }, { name: "depends-on:7" }],
          },
        ];
      }),
    });

    await expect(
      tracker.listOpenIssuesByLabel("wait:dependency"),
    ).resolves.toEqual([
      { number: 12, body: "Body", labels: ["wait:dependency", "depends-on:7"] },
    ]);
    expect(ghCalls).toEqual([]);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        cacheKey: "red-castle:issues:owner/repo:open:wait:dependency:1",
        route: "GET /repos/{owner}/{repo}/issues",
        parameters: {
          owner: "owner",
          repo: "repo",
          state: "open",
          labels: "wait:dependency",
          per_page: 100,
          page: 1,
        },
        operation: { key: "issue list", budget: "rest" },
      }),
    );
  });

  it("preserves tracker behavior across routed GitHub reads and writes", async () => {
    const calls: string[][] = [];
    const comments: Array<{ id: number; body: string; createdAt: string }> = [];
    const requests: Parameters<GithubClient["conditionalRest"]>[0][] = [];
    const gh: GhExec = async (args) => {
      calls.push([...args]);
      const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
      if (path === "repos/owner/repo/issues")
        return JSON.stringify({ number: 77 });
      if (path.endsWith("/comments")) {
        const bodyArg = args.find((arg) => arg.startsWith("body=")) ?? "body=";
        const id = 500 + comments.length;
        comments.push({
          id,
          body: bodyArg.slice("body=".length),
          createdAt: "2026-07-16T00:00:00Z",
        });
        return JSON.stringify({ id });
      }
      return "{}";
    };

    const claimLockRoot = await mkdtemp(
      join(tmpdir(), "red-castle-gh-tracker-"),
    );
    const tracker = createGitHubTrackerAdapter({
      gh,
      repo: "owner/repo",
      claimLockRoot,
      github: githubStub((request) => {
        requests.push(request);
        if (request.route.endsWith("/comments")) {
          return comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            created_at: comment.createdAt,
          }));
        }
        if (request.route === "GET /repos/{owner}/{repo}/issues") {
          return [
            {
              number: 12,
              body: "Body",
              labels: [{ name: "wait:dependency" }, { name: "depends-on:7" }],
            },
          ];
        }
        return {
          state: "closed",
          number: 7,
          title: "Base",
          html_url: "https://example.invalid/7",
          labels: [{ name: "wait:dependency" }, { name: "depends-on:7" }],
        };
      }),
    });

    try {
      await expect(
        tracker.createIssue?.({
          title: "/go: x",
          body: "demand",
          labels: ["lane:go", "kind,with-comma"],
        }),
      ).resolves.toBe(77);
      await expect(
        tracker.listOpenIssuesByLabel("wait:dependency"),
      ).resolves.toEqual([
        {
          number: 12,
          body: "Body",
          labels: ["wait:dependency", "depends-on:7"],
        },
      ]);
      await expect(tracker.isIssueClosed(7)).resolves.toBe(true);
      await tracker.editIssueLabels(12, {
        remove: ["wait:dependency", "depends-on:7"],
        add: ["queue:agent", "priority:normal"],
      });
      await tracker.commentOnIssue(12, "done");
      await expect(
        tracker.claimIssueLease?.({
          issue: 12,
          worker: "host:w1",
          runner: "codex",
          liveness: (worker) => (worker === "host:w1" ? "alive" : "unknown"),
        }),
      ).resolves.toMatchObject({ verdict: "won", winner: "host:w1" });
      await tracker.retireIssueLease?.({
        issue: 12,
        worker: "host:w1",
        runner: "codex",
      });
    } finally {
      await rm(claimLockRoot, { recursive: true, force: true });
    }

    expect(
      comments
        .map((comment) => comment.body)
        .filter((body) => body.includes("afk:claim")),
    ).toEqual([
      expect.stringContaining(
        "<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->",
      ),
      expect.stringContaining(
        "<!-- afk:claim v1 worker=host:w1 kind=concede reason=released runner=codex -->",
      ),
    ]);

    expect(calls).toEqual([
      [
        "api",
        "-X",
        "POST",
        "repos/owner/repo/issues",
        "-f",
        "title=/go: x",
        "-f",
        "body=demand",
        "-F",
        "labels[]=lane:go",
        "-F",
        "labels[]=kind,with-comma",
      ],
      [
        "api",
        "-X",
        "PATCH",
        "repos/owner/repo/issues/12",
        "-F",
        "labels[]=queue:agent",
        "-F",
        "labels[]=priority:normal",
      ],
      [
        "api",
        "-X",
        "POST",
        "repos/owner/repo/issues/12/comments",
        "-f",
        "body=done",
      ],
      [
        "api",
        "-X",
        "POST",
        "repos/owner/repo/issues/12/comments",
        "-f",
        expect.stringContaining(
          "body=<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->",
        ),
      ],
      [
        "api",
        "-X",
        "POST",
        "repos/owner/repo/issues/12/comments",
        "-f",
        expect.stringContaining(
          "body=<!-- afk:claim v1 worker=host:w1 kind=concede reason=released runner=codex -->",
        ),
      ],
    ]);
    expect(requests.map((request) => request.route)).toEqual([
      "GET /repos/{owner}/{repo}/issues",
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
    ]);
  });

  // #2749 — the external-close reconcile read. Repeated `--label` flags are
  // ANDed by gh, so every state role must ride ONE `label:"a","b"` search
  // qualifier: a per-label loop on a timer-driven sweep is a flow bug.
  it("reads closed issues for any state role in one bounded search", async () => {
    const requests: Parameters<GithubClient["conditionalRest"]>[0][] = [];
    const tracker = createGitHubTrackerAdapter({
      repo: "owner/repo",
      gh: async () => {
        throw new Error("closed issue searches must not reach gh");
      },
      github: githubStub((request) => {
        requests.push(request);
        return {
          items: [
            {
              number: 2724,
              body: "B",
              labels: [{ name: "ready-for-human" }, { name: "spec:2723" }],
            },
          ],
        };
      }),
    });

    await expect(
      tracker.listClosedIssuesByAnyLabel?.(
        ["ready-for-human", "blocked:dependency"],
        25,
      ),
    ).resolves.toEqual([
      { number: 2724, body: "B", labels: ["ready-for-human", "spec:2723"] },
    ]);

    expect(requests).toEqual([
      expect.objectContaining({
        cacheKey:
          "red-castle:issues:owner/repo:closed:any:ready-for-human,blocked:dependency:1:25",
        route: "GET /search/issues",
        parameters: {
          q: 'repo:owner/repo is:issue is:closed label:"ready-for-human","blocked:dependency"',
          per_page: 25,
          page: 1,
        },
        operation: { key: "issue list", budget: "rest" },
      }),
    ]);
  });

  it("skips the tracker call entirely for an empty label set", async () => {
    const calls: string[][] = [];
    const tracker = createGitHubTrackerAdapter({
      gh: async (args) => {
        calls.push([...args]);
        return "";
      },
    });

    await expect(tracker.listClosedIssuesByAnyLabel?.([], 25)).resolves.toEqual(
      [],
    );
    expect(calls).toEqual([]);
  });
});
