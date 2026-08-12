import { describe, expect, it } from "vitest";
import { planGithubWrite } from "./write-plan.js";

describe("planGithubWrite — the client owns the write rail", () => {
  it("realizes the default merge on REST with the subject carried", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "pr", "merge", "42", "--merge", "--subject", "fix: #9 Fix",
    ]);
    expect(plan.surface).toBe("rest");
    expect(plan.args).toEqual([
      "gh", "api", "-X", "PUT", "repos/o/r/pulls/42/merge",
      "-f", "merge_method=merge", "-f", "commit_title=fix: #9 Fix",
    ]);
  });

  it("keeps --auto on the CLI: the queue enqueue is GraphQL-only", () => {
    const argv = ["gh", "-R", "o/r", "pr", "merge", "42", "--merge", "--auto"];
    const plan = planGithubWrite(argv);
    expect(plan.surface).toBe("graphql");
    expect(plan.args).toBe(argv);
  });

  it("realizes pr create on REST, draft flag included", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "pr", "create", "--draft",
      "--base", "main", "--head", "afk/x", "--title", "t", "--body", "b",
    ]);
    expect(plan.surface).toBe("rest");
    expect(plan.args).toEqual([
      "gh", "api", "-X", "POST", "repos/o/r/pulls",
      "-F", "draft=true", "-f", "base=main", "-f", "head=afk/x", "-f", "title=t", "-f", "body=b",
    ]);
  });

  it("realizes issue label and body edits as one REST PATCH", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "issue", "edit", "42",
      "--remove-label", "running", "--add-label", "ready-for-human", "--body", "next",
    ], { currentIssueLabels: ["type:bug", "running"] });
    expect(plan.surface).toBe("rest");
    expect(plan.args).toEqual([
      "gh", "api", "-X", "PATCH", "repos/o/r/issues/42",
      "-f", "body=next",
      "-F", "labels[]=type:bug",
      "-F", "labels[]=ready-for-human",
    ]);
  });

  it("realizes issue closure as a REST PATCH", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "issue", "close", "42", "--reason", "completed",
    ]);
    expect(plan.surface).toBe("rest");
    expect(plan.args).toEqual([
      "gh", "api", "-X", "PATCH", "repos/o/r/issues/42",
      "-f", "state=closed", "-f", "state_reason=completed",
    ]);
  });

  it("passes an unsupported issue edit through unchanged", () => {
    const argv = ["gh", "-R", "o/r", "issue", "edit", "42", "--title", "renamed"];
    const plan = planGithubWrite(argv);
    expect(plan.surface).toBe("graphql");
    expect(plan.args).toBe(argv);
  });

  it("realizes an issue comment on REST", () => {
    const plan = planGithubWrite([
      "gh", "issue", "comment", "42", "--repo", "o/r", "--body", "resolved",
    ]);
    expect(plan).toEqual({
      surface: "rest",
      args: ["gh", "api", "-X", "POST", "repos/o/r/issues/42/comments", "-f", "body=resolved"],
    });
  });

  it("realizes a pull request comment on the shared REST issue-comment endpoint", () => {
    const plan = planGithubWrite([
      "gh", "pr", "comment", "42", "--repo", "o/r", "--body", "resolved",
    ]);
    expect(plan).toEqual({
      surface: "rest",
      args: ["gh", "api", "-X", "POST", "repos/o/r/issues/42/comments", "-f", "body=resolved"],
    });
  });

  it.each([
    {
      name: "issue creation",
      argv: ["gh", "-R", "o/r", "issue", "create", "--title", "t", "--body", "b", "--label", "ready-for-agent"],
      context: {},
      expected: ["gh", "api", "-X", "POST", "repos/o/r/issues", "-f", "title=t", "-f", "body=b", "-F", "labels[]=ready-for-agent"],
    },
    {
      name: "PR comment",
      argv: ["gh", "pr", "comment", "42", "--repo", "o/r", "--body", "reviewed"],
      context: {},
      expected: ["gh", "api", "-X", "POST", "repos/o/r/issues/42/comments", "-f", "body=reviewed"],
    },
    {
      name: "label creation",
      argv: ["gh", "label", "create", "reviewed", "--repo", "o/r", "--color", "5319E7", "--description", "Review state"],
      context: {},
      expected: ["gh", "api", "-X", "POST", "repos/o/r/labels", "-f", "name=reviewed", "-f", "color=5319E7", "-f", "description=Review state"],
    },
    {
      name: "PR label edit",
      argv: ["gh", "pr", "edit", "42", "--repo", "o/r", "--remove-label", "old", "--add-label", "reviewed"],
      context: { currentIssueLabels: ["old", "type:feature"] },
      expected: ["gh", "api", "-X", "PATCH", "repos/o/r/issues/42", "-F", "labels[]=type:feature", "-F", "labels[]=reviewed"],
    },
  ])("realizes $name on REST", ({ argv, context, expected }) => {
    expect(planGithubWrite(argv, context)).toEqual({ surface: "rest", args: expected });
  });

  it("preserves an explicit REST API mutation on the REST rail", () => {
    const argv = [
      "gh", "api", "repos/o/r/issues/comments/99", "--method", "PATCH", "--field", "body=updated",
    ];
    const plan = planGithubWrite(argv);
    expect(plan).toEqual({ surface: "rest", args: argv });
  });

  it("realizes a pull-request label addition on REST", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "pr", "edit", "42", "--add-label", "ready-for-review",
    ]);
    expect(plan).toEqual({
      surface: "rest",
      args: [
        "gh", "api", "-X", "POST", "repos/o/r/issues/42/labels",
        "-F", "labels[]=ready-for-review",
      ],
    });
  });

  it("realizes a pull-request body edit on REST", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "pr", "edit", "42", "--body", "updated trail",
    ]);
    expect(plan).toEqual({
      surface: "rest",
      args: [
        "gh", "api", "-X", "PATCH", "repos/o/r/pulls/42",
        "-f", "body=updated trail",
      ],
    });
  });

  it("does not partially realize a combined pull-request edit", () => {
    const argv = [
      "gh", "-R", "o/r", "pr", "edit", "42",
      "--body", "updated trail", "--add-label", "ready-for-review",
    ];
    expect(planGithubWrite(argv)).toEqual({ surface: "graphql", args: argv });
  });

  it("realizes pull-request update-branch on REST", () => {
    const plan = planGithubWrite([
      "gh", "-R", "o/r", "pr", "update-branch", "42",
    ]);
    expect(plan).toEqual({
      surface: "rest",
      args: ["gh", "api", "-X", "PUT", "repos/o/r/pulls/42/update-branch"],
    });
  });

  it("declares pull-request readiness as GraphQL-only", () => {
    const argv = ["gh", "-R", "o/r", "pr", "ready", "42"];
    expect(planGithubWrite(argv)).toEqual({ surface: "graphql", args: argv });
  });
});
