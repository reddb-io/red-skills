import { describe, expect, it } from "vitest";
import {
  createGithubReleaseWaitAdapter,
  watchVersionPullRequest,
  type ReleaseWaitGithub,
  type ReleaseWaitPullRequest,
  type ReleaseWaitRun,
} from "../src/release-wait.js";
import { runMain } from "../src/cli.js";
import type { GithubClient } from "@reddb-io/github";

describe("Version-PR release wait", () => {
  it("signals the six-run 2026-08-08 workflow-approval stall", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 3824,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "release-head",
        mergeState: "blocked",
      },
      actionRequiredRuns: Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        name: `release check ${index + 1}`,
        headCommit: "release-head",
        createdAt: `2026-08-08T12:0${index}:00Z`,
      })),
      requiredContexts: ["test", "typecheck"],
      checks: [],
    });

    await expect(
      watchVersionPullRequest({ github }),
    ).resolves.toMatchObject({
      state: "awaiting-approval",
      signal: "opened",
      pullRequest: 3824,
      runCount: 6,
    });
    expect(github.alert).toMatchObject({
      title: "Release wait: workflow approval needed for Version PR #3824",
    });
    expect(github.alert?.body).toContain("6 workflow runs are waiting for approval");
    expect(github.alert?.body).toContain("2026-08-08T12:00:00.000Z");
    expect(github.alert?.body).toContain("<!-- red-release-wait:v1 -->");
  });

  it("signals required contexts that never started without calling them approval-held", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 3900,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "untriggered-head",
        mergeState: "blocked",
      },
      actionRequiredRuns: [],
      requiredContexts: ["test", "typecheck"],
      checks: [{ name: "third-party", status: "success" }],
    });

    await expect(watchVersionPullRequest({ github })).resolves.toMatchObject({
      state: "required-contexts-missing",
      signal: "opened",
      pullRequest: 3900,
      missingContexts: ["test", "typecheck"],
    });
    expect(github.alert?.title).toBe("Release wait: checks never started for Version PR #3900");
    expect(github.alert?.body).toContain("test, typecheck");
    expect(github.alert?.body).not.toContain("waiting for approval");
  });

  it("does not page when the Version PR is merely behind its strict base", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 3824,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "behind-head",
        mergeState: "behind",
      },
      actionRequiredRuns: [],
      requiredContexts: ["test", "typecheck"],
      checks: [
        { name: "test", status: "success" },
        { name: "typecheck", status: "success" },
      ],
    });

    await expect(watchVersionPullRequest({ github })).resolves.toEqual({
      state: "behind-base",
      signal: "none",
      pullRequest: 3824,
    });
    expect(github.alert).toBeNull();
  });

  it("distinguishes a failing required check from an approval wait", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 4000,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "failed-head",
        mergeState: "blocked",
      },
      actionRequiredRuns: [],
      requiredContexts: ["test", "typecheck"],
      checks: [
        { name: "test", status: "failure" },
        { name: "typecheck", status: "success" },
      ],
    });

    await expect(watchVersionPullRequest({ github })).resolves.toEqual({
      state: "checks-failed",
      signal: "none",
      pullRequest: 4000,
      failedContexts: ["test"],
    });
    expect(github.alert).toBeNull();
  });

  it("resolves an old alert when only strict-base lag remains", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 3824,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "behind-head",
        mergeState: "behind",
      },
      actionRequiredRuns: [],
      requiredContexts: ["test"],
      checks: [{ name: "test", status: "success" }],
    });
    github.alert = {
      number: 99,
      title: "Release waiting for workflow approval: Version PR #3824",
      body: "stale",
    };

    await expect(watchVersionPullRequest({ github })).resolves.toMatchObject({
      state: "behind-base",
      signal: "resolved",
    });
    expect(github.alert).toBeNull();
  });

  it("is a successful no-op when no Version PR is open", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: null,
      actionRequiredRuns: [],
      requiredContexts: [],
      checks: [],
    });

    await expect(watchVersionPullRequest({ github })).resolves.toEqual({
      state: "no-version-pr",
      signal: "none",
    });
  });

  it("exposes the watcher as a stateful release command", async () => {
    const client = {
      async conditionalRest(request: { route: string }) {
        if (request.route === "GET /repos/{owner}/{repo}/pulls") {
          return { data: [], headers: {}, quotaFree: false };
        }
        if (request.route === "GET /search/issues") {
          return { data: { items: [] }, headers: {}, quotaFree: false };
        }
        throw new Error(`unexpected route ${request.route}`);
      },
    } as unknown as GithubClient;
    let output = "";

    await expect(runMain(["watch"], {
      env: { GITHUB_REPOSITORY: "example/widgets" },
      githubClient: client,
      write: (text) => { output += text; },
    })).resolves.toBe(0);
    expect(JSON.parse(output)).toEqual({ state: "no-version-pr", signal: "none" });
  });

  it("turns the 541-run current-head backlog into a GitHub Ticket signal", async () => {
    const writes: Array<{ route: string; parameters: Record<string, unknown> }> = [];
    const runs = Array.from({ length: 541 }, (_, index) => ({
      id: index + 1,
      name: `workflow ${index + 1}`,
      head_sha: "current-head",
      created_at: new Date(Date.UTC(2026, 7, 7, 12, index % 60)).toISOString(),
    }));
    const client = {
      async conditionalPaginate(request: { route: string }) {
        expect(request.route).toBe("GET /repos/{owner}/{repo}/actions/runs");
        return { data: runs, headers: {}, requestCount: 6, quotaFree: false };
      },
      async conditionalRest(request: { route: string; parameters: Record<string, unknown> }) {
        switch (request.route) {
          case "GET /repos/{owner}/{repo}/pulls":
            return { data: [{ number: 3824 }], headers: {}, quotaFree: false };
          case "GET /repos/{owner}/{repo}/pulls/{pull_number}":
            return { data: {
              number: 3824,
              base: { ref: "main" },
              head: { ref: "red-release/version-pr", sha: "current-head" },
              mergeable_state: "blocked",
            }, headers: {}, quotaFree: false };
          case "GET /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks":
            return { data: { contexts: ["test", "typecheck"], checks: [] }, headers: {}, quotaFree: false };
          case "GET /repos/{owner}/{repo}/commits/{ref}/check-runs":
            return { data: { check_runs: [] }, headers: {}, quotaFree: false };
          case "GET /repos/{owner}/{repo}/commits/{ref}/status":
            return { data: { statuses: [] }, headers: {}, quotaFree: false };
          case "GET /search/issues":
            expect(request.parameters.q).toBe(
              "repo:example/widgets is:issue is:open in:title \"Release wait:\"",
            );
            return { data: { items: [] }, headers: {}, quotaFree: false };
          case "POST /repos/{owner}/{repo}/issues":
            writes.push(request);
            return { data: { number: 77 }, headers: {}, quotaFree: false };
          default:
            throw new Error(`unexpected route ${request.route}`);
        }
      },
    } as unknown as GithubClient;

    const result = await watchVersionPullRequest({
      github: createGithubReleaseWaitAdapter({
        client,
        owner: "example",
        repository: "widgets",
      }),
    });

    expect(result).toMatchObject({ state: "awaiting-approval", runCount: 541, signal: "opened" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.parameters).toMatchObject({
      title: "Release wait: workflow approval needed for Version PR #3824",
    });
  });

  it("reports a healthy Version PR without paging", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 4100,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "clean-head",
        mergeState: "clean",
      },
      actionRequiredRuns: [],
      requiredContexts: ["test"],
      checks: [{ name: "test", status: "success" }],
    });

    await expect(watchVersionPullRequest({ github })).resolves.toEqual({
      state: "clear",
      signal: "none",
      pullRequest: 4100,
    });
  });

  it("distinguishes ordinary pending checks from approval-held runs", async () => {
    const github = new FakeReleaseWaitGithub({
      pullRequest: {
        number: 4200,
        base: "main",
        head: "red-release/version-pr",
        headCommit: "pending-head",
        mergeState: "blocked",
      },
      actionRequiredRuns: [],
      requiredContexts: ["test", "typecheck"],
      checks: [
        { name: "test", status: "pending" },
        { name: "typecheck", status: "success" },
      ],
    });

    await expect(watchVersionPullRequest({ github })).resolves.toEqual({
      state: "checks-pending",
      signal: "none",
      pullRequest: 4200,
      pendingContexts: ["test"],
    });
  });
});

class FakeReleaseWaitGithub implements ReleaseWaitGithub {
  alert: { number: number; title: string; body: string } | null = null;

  constructor(private readonly fixture: {
    pullRequest: ReleaseWaitPullRequest | null;
    actionRequiredRuns: readonly ReleaseWaitRun[];
    requiredContexts: readonly string[];
    checks: readonly { name: string; status: "pending" | "success" | "failure" }[];
  }) {}

  async findOpenVersionPullRequest() { return this.fixture.pullRequest; }
  async listActionRequiredRuns() { return this.fixture.actionRequiredRuns; }
  async listRequiredContexts() { return this.fixture.requiredContexts; }
  async listChecks() { return this.fixture.checks; }
  async findOpenAlert() { return this.alert; }
  async openAlert(input: { title: string; body: string }) {
    this.alert = { number: 1, ...input };
    return { number: 1 };
  }
  async updateAlert(number: number, input: { title: string; body: string }) {
    this.alert = { number, ...input };
  }
  async closeAlert() { this.alert = null; }
}
