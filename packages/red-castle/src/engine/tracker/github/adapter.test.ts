import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHubTrackerAdapter, type GhExec } from "./adapter.js";

describe("GitHub tracker adapter", () => {
  it("quarantines tracker IO behind gh CLI calls", async () => {
    const calls: string[][] = [];
    const comments: Array<{ id: number; body: string; createdAt: string }> = [];
    const gh: GhExec = async (args) => {
      calls.push([...args]);
      if (args[0] === "issue" && args[1] === "list") {
        return JSON.stringify([
          {
            number: 12,
            body: "Body",
            labels: [{ name: "wait:dependency" }, { name: "depends-on:7" }],
          },
        ]);
      }
      if (
        args[0] === "issue" &&
        args[1] === "view" &&
        args.includes("comments")
      ) {
        return JSON.stringify({ comments });
      }
      // One issue by number is a single-object read, so `@reddb-io/github`
      // routes it to REST and the fake answers a REST body (#3094).
      if (args[0] === "api" && /\/issues\/\d+$/.test(args[1] ?? "")) {
        return JSON.stringify({
          state: "closed",
          number: 7,
          title: "Base",
          html_url: "https://example.invalid/7",
        });
      }
      if (args[0] === "api") {
        const bodyArg = args.find((arg) => arg.startsWith("body=")) ?? "body=";
        const id = 500 + comments.length;
        comments.push({
          id,
          body: bodyArg.slice("body=".length),
          createdAt: "2026-07-16T00:00:00Z",
        });
        return `${id}\n`;
      }
      if (args[0] === "issue" && args[1] === "create") {
        return "https://github.com/owner/repo/issues/77\n";
      }
      return "";
    };

    const claimLockRoot = await mkdtemp(
      join(tmpdir(), "red-castle-gh-tracker-"),
    );
    const tracker = createGitHubTrackerAdapter({
      gh,
      repo: "owner/repo",
      claimLockRoot,
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
        remove: ["wait:dependency"],
        add: ["queue:agent"],
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

    expect(comments.map((comment) => comment.body)).toEqual([
      expect.stringContaining(
        "<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->",
      ),
      expect.stringContaining(
        "<!-- afk:claim v1 worker=host:w1 kind=concede reason=released runner=codex -->",
      ),
    ]);

    expect(calls).toEqual([
      [
        "issue",
        "create",
        "--title",
        "/go: x",
        "--body",
        "demand",
        "--label",
        "lane:go",
        "--label",
        "kind,with-comma",
        "--repo",
        "owner/repo",
      ],
      [
        "issue",
        "list",
        "--state",
        "open",
        "--label",
        "wait:dependency",
        "--json",
        "number,body,labels",
        "--limit",
        "1000",
        "--repo",
        "owner/repo",
      ],
      // The single-object read addresses REST; the comment listing below has no
      // single-request REST projection and keeps gh's own command (#3094).
      ["api", "repos/owner/repo/issues/7"],
      [
        "issue",
        "edit",
        "12",
        "--remove-label",
        "wait:dependency",
        "--add-label",
        "queue:agent",
        "--repo",
        "owner/repo",
      ],
      ["issue", "comment", "12", "--body", "done", "--repo", "owner/repo"],
      [
        "api",
        "repos/owner/repo/issues/12/comments",
        "-f",
        expect.stringContaining(
          "body=<!-- afk:claim v1 worker=host:w1 kind=claim runner=codex -->",
        ),
        "--jq",
        ".id",
      ],
      ["issue", "view", "12", "--json", "comments", "--repo", "owner/repo"],
      [
        "api",
        "repos/owner/repo/issues/12/comments",
        "-f",
        expect.stringContaining(
          "body=<!-- afk:claim v1 worker=host:w1 kind=concede reason=released runner=codex -->",
        ),
        "--jq",
        ".id",
      ],
    ]);
  });

  // #2749 — the external-close reconcile read. Repeated `--label` flags are
  // ANDed by gh, so every state role must ride ONE `label:"a","b"` search
  // qualifier: a per-label loop on a timer-driven sweep is a flow bug.
  it("reads closed issues for any state role in one bounded search", async () => {
    const calls: string[][] = [];
    const gh: GhExec = async (args) => {
      calls.push([...args]);
      return JSON.stringify([
        { number: 2724, body: "B", labels: [{ name: "ready-for-human" }, { name: "spec:2723" }] },
      ]);
    };
    const tracker = createGitHubTrackerAdapter({ gh, repo: "owner/repo" });

    await expect(
      tracker.listClosedIssuesByAnyLabel?.(["ready-for-human", "blocked:dependency"], 25),
    ).resolves.toEqual([{ number: 2724, body: "B", labels: ["ready-for-human", "spec:2723"] }]);

    expect(calls).toEqual([
      [
        "issue",
        "list",
        "--state",
        "closed",
        "--search",
        'label:"ready-for-human","blocked:dependency"',
        "--json",
        "number,body,labels",
        "--limit",
        "25",
        "--repo",
        "owner/repo",
      ],
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

    await expect(tracker.listClosedIssuesByAnyLabel?.([], 25)).resolves.toEqual([]);
    expect(calls).toEqual([]);
  });
});
