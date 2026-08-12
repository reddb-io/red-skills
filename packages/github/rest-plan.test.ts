import { describe, expect, it } from "vitest";
import { githubJsonFields, planGithubRestRead, type GithubRestReadPlan } from "./rest-plan.js";

function plan(read: ReturnType<typeof planGithubRestRead>): GithubRestReadPlan {
  if (read.outcome !== "plan") throw new Error(`expected a plan, got: ${read.reason}`);
  return read;
}

const ISSUE_BODY = JSON.stringify({
  number: 42,
  title: "the drain stalls",
  body: "a body",
  state: "closed",
  state_reason: "completed",
  html_url: "https://github.com/acme/widgets/issues/42",
  created_at: "2026-08-01T10:00:00Z",
  closed_at: "2026-08-02T10:00:00Z",
  labels: [
    { id: 1, node_id: "LA_1", name: "running", description: "", color: "ededed" },
    { id: 2, node_id: "LA_2", name: "ready-for-agent", description: "d", color: "0e8a16" },
  ],
});

describe("planGithubRestRead — issues", () => {
  it("projects the REST database id used by issue relationship endpoints", () => {
    const read = plan(planGithubRestRead({ kind: "issue", number: 42, fields: ["databaseId"], repo: "acme/widgets" }));
    expect(read.decode(JSON.stringify({ id: 12345 }))).toEqual({ databaseId: 12345 });
  });

  it("issues one gh api request against the repository path", () => {
    const read = plan(planGithubRestRead({ kind: "issue", number: 42, fields: ["state", "labels"], repo: "acme/widgets" }));
    expect(read.args).toEqual(["api", "repos/acme/widgets/issues/42"]);
  });

  it("falls back to gh's own owner/repo placeholders when no slug is known", () => {
    const read = plan(planGithubRestRead({ kind: "issue", number: 7, fields: ["state"] }));
    expect(read.path).toBe("repos/{owner}/{repo}/issues/7");
  });

  it("projects the REST body into the shape --json would have printed", () => {
    const read = plan(
      planGithubRestRead({
        kind: "issue",
        number: 42,
        fields: ["state", "labels", "closedAt", "url", "title", "stateReason"],
        repo: "acme/widgets",
      }),
    );
    expect(read.decode(ISSUE_BODY)).toEqual({
      state: "CLOSED",
      stateReason: "COMPLETED",
      closedAt: "2026-08-02T10:00:00Z",
      url: "https://github.com/acme/widgets/issues/42",
      title: "the drain stalls",
      labels: [
        { id: "LA_1", name: "running", description: "", color: "ededed" },
        { id: "LA_2", name: "ready-for-agent", description: "d", color: "0e8a16" },
      ],
    });
  });

  it("carries exactly the requested fields and nothing more", () => {
    const read = plan(planGithubRestRead({ kind: "issue", number: 42, fields: ["state"], repo: "acme/widgets" }));
    expect(Object.keys(read.decode(ISSUE_BODY))).toEqual(["state"]);
  });

  it("reports an open issue's closedAt as null, never as a zero timestamp", () => {
    const read = plan(planGithubRestRead({ kind: "issue", number: 42, fields: ["state", "closedAt"] }));
    expect(read.decode(JSON.stringify({ state: "open", closed_at: null }))).toEqual({
      state: "OPEN",
      closedAt: null,
    });
  });

  it("raises on an unparseable body rather than reporting an empty object", () => {
    const read = plan(planGithubRestRead({ kind: "issue", number: 42, fields: ["state"] }));
    expect(() => read.decode("")).toThrow(/non-object payload/);
    expect(() => read.decode("[]")).toThrow(/non-object payload/);
  });
});

describe("planGithubRestRead — pull requests", () => {
  const PR_BODY = JSON.stringify({
    number: 7,
    state: "open",
    merged: false,
    merged_at: null,
    merge_commit_sha: "abc123",
    mergeable: true,
    mergeable_state: "clean",
    draft: false,
    auto_merge: { enabled_at: "2026-08-02T11:00:00Z", merge_method: "merge" },
    head: { ref: "afk/3094-x", sha: "headsha" },
    base: { ref: "main", sha: "basesha" },
  });

  it("addresses the pulls path, not the issues path", () => {
    const read = plan(planGithubRestRead({ kind: "pr", number: 7, fields: ["state"], repo: "acme/widgets" }));
    expect(read.args).toEqual(["api", "repos/acme/widgets/pulls/7"]);
  });

  it("projects the merge-queue poll's fields", () => {
    const read = plan(
      planGithubRestRead({
        kind: "pr",
        number: 7,
        fields: ["state", "mergedAt", "mergeCommit", "autoMergeRequest", "mergeStateStatus", "mergeable"],
        repo: "acme/widgets",
      }),
    );
    expect(read.decode(PR_BODY)).toEqual({
      state: "OPEN",
      mergedAt: null,
      mergeCommit: { oid: "abc123" },
      autoMergeRequest: { enabledAt: "2026-08-02T11:00:00Z", mergeMethod: "MERGE" },
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    });
  });

  it("folds merged into the state enum the way GraphQL does", () => {
    const read = plan(planGithubRestRead({ kind: "pr", number: 7, fields: ["state", "mergedAt"] }));
    expect(read.decode(JSON.stringify({ state: "closed", merged: true, merged_at: "2026-08-02T12:00:00Z" }))).toEqual(
      { state: "MERGED", mergedAt: "2026-08-02T12:00:00Z" },
    );
  });

  it("reports an uncomputed mergeability as UNKNOWN, the way GraphQL does", () => {
    const read = plan(planGithubRestRead({ kind: "pr", number: 7, fields: ["mergeable", "mergeStateStatus"] }));
    expect(read.decode(JSON.stringify({ mergeable: null, mergeable_state: null }))).toEqual({
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
    });
  });

  it("reads the head and base oids off the nested REST refs", () => {
    const read = plan(planGithubRestRead({ kind: "pr", number: 7, fields: ["headRefOid", "baseRefOid", "headRefName"] }));
    expect(read.decode(PR_BODY)).toEqual({ headRefOid: "headsha", baseRefOid: "basesha", headRefName: "afk/3094-x" });
  });
});

describe("planGithubRestRead — what REST cannot answer", () => {
  it("names the comment list rather than projecting the count", () => {
    const read = planGithubRestRead({ kind: "issue", number: 42, fields: ["state", "comments"] });
    expect(read.outcome).toBe("unavailable");
    if (read.outcome !== "unavailable") return;
    expect(read.fields).toEqual(["comments"]);
    expect(read.reason).toContain("comment count, not the comment list");
  });

  it("names the check rollup rather than issuing three requests behind the caller's back", () => {
    const read = planGithubRestRead({ kind: "pr", number: 7, fields: ["mergeable", "statusCheckRollup"] });
    expect(read.outcome).toBe("unavailable");
    if (read.outcome !== "unavailable") return;
    expect(read.fields).toEqual(["statusCheckRollup"]);
  });

  it("names an author read rather than reporting a different login shape", () => {
    const read = planGithubRestRead({ kind: "issue", number: 42, fields: ["author", "authorAssociation"] });
    expect(read.outcome).toBe("unavailable");
    if (read.outcome !== "unavailable") return;
    expect(read.fields).toEqual(["author", "authorAssociation"]);
    expect(read.reason).toContain("app/<name>");
  });

  it("refuses an undeclared field instead of dropping it silently", () => {
    const read = planGithubRestRead({ kind: "issue", number: 42, fields: ["assignees"] });
    expect(read.outcome).toBe("unavailable");
    if (read.outcome !== "unavailable") return;
    expect(read.reason).toContain("no declared REST projection");
  });

  it("refuses a read that names no fields and one that names no object", () => {
    expect(planGithubRestRead({ kind: "issue", number: 42, fields: [] }).outcome).toBe("unavailable");
    expect(planGithubRestRead({ kind: "issue", number: 0, fields: ["state"] }).outcome).toBe("unavailable");
  });
});

describe("planGithubRestRead — explicit REST endpoints", () => {
  it("plans a read-only collection without admitting mutation flags (#3734)", () => {
    expect(planGithubRestRead({
      kind: "rest",
      path: "repos/o/r/issues",
      args: ["--paginate", "-f", "state=open"],
    })).toMatchObject({
      outcome: "plan",
      path: "repos/o/r/issues",
      args: ["api", "repos/o/r/issues", "--method", "GET", "--paginate", "-f", "state=open"],
    });
    expect(planGithubRestRead({ kind: "rest", path: "repos/o/r/issues", args: ["-X", "POST"] })).toMatchObject({
      outcome: "unavailable",
    });
  });

  it("plans an attributed GraphQL read without exposing a mutation door (#3734)", () => {
    expect(planGithubRestRead({ kind: "graphql", query: "query Viewer { viewer { login } }" })).toMatchObject({
      outcome: "plan",
      path: "graphql",
      args: ["api", "graphql", "-f", "query=query Viewer { viewer { login } }"],
    });
    expect(planGithubRestRead({ kind: "graphql", query: "mutation { deleteProjectV2(input: {}) { clientMutationId } }" })).toMatchObject({
      outcome: "unavailable",
    });
  });
});

describe("githubJsonFields", () => {
  it("splits gh's comma-separated field spec", () => {
    expect(githubJsonFields("state, labels ,comments")).toEqual(["state", "labels", "comments"]);
    expect(githubJsonFields("")).toEqual([]);
  });
});
