import { describe, expect, it } from "vitest";
import type { BranchRef } from "../src/core/branch-cleanup.js";
import { harness } from "./process-issue.test-helpers.js";
import { installProcessSafety, noopSafetyLogger } from "./process-issue.test-helpers.js";

// Refs #2397

installProcessSafety(noopSafetyLogger);

const PRIOR_BRANCH = "afk/wOLD1/9-fix-the-thing";

/** A prevFailureContext whose failure reason is post-gate (gate was green). */
function gateGreenContext(reason = "landing-quota-exceeded"): string {
  return `prev-attempt: 1\nprev-snapshot-branch: ${PRIOR_BRANCH}\nprev-failure-reason:\n${reason}\n`;
}

/** A prevFailureContext whose failure reason is a gate-stage failure. */
function gateStageFailed(reason = "feedback-failed"): string {
  return `prev-attempt: 1\nprev-snapshot-branch: ${PRIOR_BRANCH}\nprev-failure-reason:\n${reason}\n`;
}

const PRIOR_REFS: BranchRef[] = [
  { branch: PRIOR_BRANCH, commitS: 9000 },
];

describe("branch-resume: gate-green fast path (issue #2397)", () => {
  it("skips runAgent and re-validates directly when prior branch is gate-green", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateGreenContext(),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    // Agent must NOT have run — the fast path synthesises the done result.
    expect(trace.runAgentCalls).toHaveLength(0);
    // The resumable branch must be used as the worker branch (visible in push argv).
    const pushCalls = trace.pushedAttempt;
    expect(pushCalls.some((argv) => argv.join(" ").includes(PRIOR_BRANCH))).toBe(true);
    // An iter-log message must mention gate-green fast path.
    expect(trace.iterLogs.some((l) => l.includes("gate-green fast path"))).toBe(true);
  });

  it("does NOT call prepareFreshWorkerBranch when a resumable branch is found", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateGreenContext(),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(trace.freshWorkerBranchCalls).toHaveLength(0);
  });

  it("includes <resume-from-branch> section in the handoff for gate-green branch", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateGreenContext(),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    const handoff = trace.handoffs[0]?.content ?? "";
    expect(handoff).toContain("<resume-from-branch>");
    expect(handoff).toContain(PRIOR_BRANCH);
    expect(handoff).toContain("gate already passed");
  });
});

describe("branch-resume: non-gate-green resume path (issue #2397)", () => {
  it("runs the agent when the prior branch exists but failed at a gate stage", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateStageFailed("feedback-failed"),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    // Agent MUST run for a non-gate-green branch.
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("includes <resume-from-branch> in handoff for non-gate-green branch (agent continues)", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateStageFailed("no-sentinel"),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    const handoff = trace.handoffs[0]?.content ?? "";
    expect(handoff).toContain("<resume-from-branch>");
    expect(handoff).toContain(PRIOR_BRANCH);
    expect(handoff).toContain("Continue from where it left off");
    expect(handoff).toContain("FIRST, before anything else, sync the branch");
  });

  it("does NOT call prepareFreshWorkerBranch when a prior branch exists (even non-gate-green)", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateStageFailed(),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(trace.freshWorkerBranchCalls).toHaveLength(0);
  });

  it("hands an inherited suspect-infra feedback failure to the agent before re-validation (#3705)", async () => {
    const failure =
      "feedback-failed-infra: pnpm typecheck exit 2; suspect-infra repeated signature v1:510a86ed26095749";
    const { deps, input, trace } = harness({
      prevFailureContext: gateStageFailed(failure),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.runAgentCalls[0]?.handoffContent).toContain(failure);
    expect(trace.iterLogs.some((line) => line.includes("gate-green fast path"))).toBe(false);
  });
});

describe("branch-resume: explicit restart override (issue #2397)", () => {
  it("runs the agent and calls prepareFreshWorkerBranch when guidance says restart", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateGreenContext(),
      // Inject a trusted restart directive via comments override
    });
    // Inject a trusted restart directive via discoverBranches + comments override
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    // Override comments to return a trusted restart directive
    deps.lookups.comments = async () => [
      {
        body: "<details data-kind=\"directive\">\n<summary>directive</summary>\nPlease restart from scratch.\n</details>",
        author: "maintainer",
        sourceTrust: "trusted" as const,
      },
    ];

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    // Agent MUST run when restart is explicitly requested.
    expect(trace.runAgentCalls).toHaveLength(1);
    // prepareFreshWorkerBranch MUST be called when no resume is in effect.
    expect(trace.freshWorkerBranchCalls).toHaveLength(1);
  });

  it("omits <resume-from-branch> from handoff when restart is requested", async () => {
    const { deps, input, trace } = harness({
      prevFailureContext: gateGreenContext(),
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    deps.lookups.comments = async () => [
      {
        body: "<details data-kind=\"directive\">\n<summary>directive</summary>\nPlease restart from scratch.\n</details>",
        author: "maintainer",
        sourceTrust: "trusted" as const,
      },
    ];

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    const handoff = trace.handoffs[0]?.content ?? "";
    expect(handoff).not.toContain("<resume-from-branch>");
  });
});

describe("branch-resume: no prior branch (issue #2397)", () => {
  it("uses one deterministic branch per issue, independent of worker identity", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => [];

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, { ...input, workerId: "wOTHER" }),
    );

    // The base is the fork the HOST granted, not a ref this worker fetched for
    // itself: the worker-side trunk fetch is gone, so `red-trunk` no longer
    // exists to cut from.
    expect(trace.freshWorkerBranchCalls).toEqual([
      { branch: "afk/9-fix-the-thing", baseRef: "granted-fork-sha", force: false },
    ]);
    expect(trace.runAgentCalls[0]?.branch).toBe("afk/9-fix-the-thing");
  });

  it("runs the agent and calls prepareFreshWorkerBranch when no prior branch exists", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => [];

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.freshWorkerBranchCalls).toHaveLength(1);
  });

  it("omits <resume-from-branch> from handoff when no prior branch exists", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => [];

    await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    const handoff = trace.handoffs[0]?.content ?? "";
    expect(handoff).not.toContain("<resume-from-branch>");
  });

  it("runs normally when discoverBranches is not wired (undefined)", async () => {
    // Existing callers that have not yet wired discoverBranches get normal behaviour.
    const { deps, input, trace } = harness({});
    // discoverBranches is NOT set on deps.lookups (it's optional)

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
  });
});

describe("branch-resume: existing open PR adoption (issue #2416)", () => {
  it("adopts a matching open PR through the gate without creating a branch or running the agent", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => [];
    Object.assign(deps.lookups, {
      discoverOpenPullRequests: async () => [
        { number: 2398, headRefName: "afk/wOLD1/9-first-attempt", body: "Closes #9" },
        { number: 2408, headRefName: "afk/9-fix-the-thing", body: "Closes #9" },
      ],
    });

    const result = await import("../src/core/process-issue.js").then((m) =>
      m.processIssue(deps, input),
    );

    expect(result.outcome).toBe("done");
    expect(result.branch).toBe("afk/9-fix-the-thing");
    expect(trace.runAgentCalls).toHaveLength(0);
    expect(trace.freshWorkerBranchCalls).toHaveLength(0);
    expect(trace.iterLogs.some((line) => line.includes("adopting open PR #2408"))).toBe(true);
    expect(trace.comments.some((comment) =>
      comment.body.includes("Attempt PRs for #9: #2398, #2408")
    )).toBe(true);
  });
});

describe("branch adoption is decided on commits, not on the ref name (issue #2865)", () => {
  /** The empty ref every worktree creation pushes before the agent writes a line. */
  const EMPTY_REFS: BranchRef[] = [{ branch: "afk/9-fix-the-thing", commitS: 9000 }];

  it("prepares a fresh branch when the matching ref carries no commits ahead of the base", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => EMPTY_REFS;
    Object.assign(deps.lookups, { branchCommitsAhead: async () => 0 });

    await import("../src/core/process-issue.js").then((m) => m.processIssue(deps, input));

    expect(trace.freshWorkerBranchCalls).toHaveLength(1);
    expect(trace.handoffs[0]?.content ?? "").not.toContain("<resume-from-branch>");
  });

  it("surfaces a branch that carries commits and has no open pull request", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    Object.assign(deps.lookups, { branchCommitsAhead: async () => 9 });

    await import("../src/core/process-issue.js").then((m) => m.processIssue(deps, input));

    expect(trace.comments.some((c) =>
      c.body.includes(PRIOR_BRANCH) && c.body.includes("9 commits") &&
      c.body.includes("no open pull request")
    )).toBe(true);
    expect(trace.freshWorkerBranchCalls).toHaveLength(0);
    expect(trace.handoffs[0]?.content ?? "").toContain("<resume-from-branch>");
  });

  it("opens a draft route before resuming a preserved branch with commits", async () => {
    let routeWasOpenWhenAgentStarted = false;
    const { deps, input, trace } = harness({
      onRunAgent: async () => {
        routeWasOpenWhenAgentStarted = trace.mergeCalls.some((argv) =>
          argv.join(" ").includes("pr create --draft --base main")
        );
      },
    });
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    Object.assign(deps.lookups, {
      branchCommitsAhead: async () => 9,
      discoverOpenPullRequests: async () => [],
    });

    await import("../src/core/process-issue.js").then((m) => m.processIssue(deps, input));

    expect(routeWasOpenWhenAgentStarted).toBe(true);
    expect(trace.mergeCalls).toContainEqual([
      "gh",
      "-R",
      "o/r",
      "pr",
      "create",
      "--draft",
      "--base",
      "main",
      "--head",
      PRIOR_BRANCH,
      "--title",
      "resume: #9",
      "--body",
      expect.stringContaining("Closes #9"),
    ]);
  });

  it("records on the issue why a restart refused a branch that carries work", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    Object.assign(deps.lookups, { branchCommitsAhead: async () => 9 });
    deps.lookups.comments = async () => [
      {
        body: "<details data-kind=\"directive\">\n<summary>directive</summary>\nPlease restart from scratch.\n</details>",
        author: "maintainer",
        sourceTrust: "trusted" as const,
      },
    ];

    await import("../src/core/process-issue.js").then((m) => m.processIssue(deps, input));

    expect(trace.comments.some((c) =>
      c.body.includes(PRIOR_BRANCH) && c.body.includes("NOT adopted") && c.body.includes("restart")
    )).toBe(true);
    expect(trace.freshWorkerBranchCalls).toHaveLength(1);
  });

  it("adopts rather than resets when the commit count cannot be read", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    Object.assign(deps.lookups, { branchCommitsAhead: async () => undefined });

    await import("../src/core/process-issue.js").then((m) => m.processIssue(deps, input));

    expect(trace.freshWorkerBranchCalls).toHaveLength(0);
    expect(trace.handoffs[0]?.content ?? "").toContain("<resume-from-branch>");
  });

  it("adopts rather than resets when the commit probe throws", async () => {
    const { deps, input, trace } = harness({});
    deps.lookups.discoverBranches = async () => PRIOR_REFS;
    Object.assign(deps.lookups, {
      branchCommitsAhead: async () => {
        throw new Error("ls-remote unreachable");
      },
    });

    await import("../src/core/process-issue.js").then((m) => m.processIssue(deps, input));

    expect(trace.freshWorkerBranchCalls).toHaveLength(0);
  });
});
