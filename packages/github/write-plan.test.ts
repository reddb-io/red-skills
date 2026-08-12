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

  it("passes an unrouted write through unchanged", () => {
    const argv = ["gh", "-R", "o/r", "pr", "ready", "42"];
    const plan = planGithubWrite(argv);
    expect(plan.args).toBe(argv);
  });
});
