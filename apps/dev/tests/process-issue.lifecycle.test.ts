import {
  DEFAULT_BRANCH_TIP,
  SCOUT_EXIT_PROTOCOL,
  describe,
  expect,
  harness,
  installProcessSafety,
  it,
  labelTrace,
  noopSafetyLogger,
  parseCurrentBlocker,
  processIssue,
  upsertCurrentBlocker,
} from "./process-issue.test-helpers.js";
import type { AttemptProgressInfo, ConfigValues, ProcessIssueDeps } from "./process-issue.test-helpers.js";
describe("processIssue — DONE + green + merged (unlocked, admin-PR landing)", () => {
  it("pre-cleans a merge-conflict retry branch before sandcastle can reuse a stale worktree", async () => {
    const fetchedBases: string[] = [];
    const priorAttemptContext = [
      "prev-attempt: 1",
      "prev-snapshot-branch: origin/afk-attempts/wOLD/9-fix-the-thing",
      "prev-failure-reason:",
      "merge-conflict",
    ].join("\n");
    const { deps, input, trace } = harness({
      attempt: 2,
      priorAttemptContext,
      fetchedBases,
      outcome: "done",
      feedbackOk: true,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(fetchedBases).toEqual(["main"]);
    expect(trace.freshWorkerBranchCalls).toEqual([
      {
        branch: "afk/wAAAA/9-fix-the-thing",
        baseRef: "red-trunk",
        force: true,
      },
    ]);
    expect(trace.runAgentCalls[0]?.base).toBe("red-trunk");
    expect(trace.handoffs[0]?.content).toContain("prev-snapshot-branch: origin/afk-attempts/wOLD/9-fix-the-thing");
    expect(trace.handoffs[0]?.content).toContain("prev-failure-reason:\nmerge-conflict");
  });

  it("keeps non-conflict same-run reuse eligible for the stale-base check only", async () => {
    const priorAttemptContext = [
      "prev-attempt: 1",
      "prev-snapshot-branch: origin/afk-attempts/wOLD/9-fix-the-thing",
      "prev-failure-reason:",
      "validation failed",
    ].join("\n");
    const { deps, input, trace } = harness({
      attempt: 2,
      priorAttemptContext,
      outcome: "done",
      feedbackOk: true,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.freshWorkerBranchCalls).toEqual([
      {
        branch: "afk/wAAAA/9-fix-the-thing",
        baseRef: "red-trunk",
        force: false,
      },
    ]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("runs claim → runAgent → push → feedback → land → close with the full transition + sweep", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.issue).toBe(9);
    expect(result.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(result.base).toBe("main");
    expect(result.locked).toBe(false);
    expect(result.mergeSha).toBe("abc1234");
    expect(result.swept).toBe(true);

    // sandcastle ran once, on the worker branch, with the handoff as promptFile.
    expect(trace.runAgentCalls.length).toBe(1);
    expect(trace.runAgentCalls[0]?.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(trace.runAgentCalls[0]?.handoffPath).toBe("/tmp/afk/workers/wAAAA/9-a1/handoff.md");
    expect(trace.runAgentCalls[0]?.runner).toBe("claude");
    expect(trace.runAgentCalls[0]?.model).toBe("claude-opus-4-8");
    expect(trace.runAgentCalls[0]?.effort).toBe("high");
    // cwd is anchored at the attempt dir so sandcastle's `.red-castle/` lands
    // under .red/ (the attempt dir), never at the repo root.
    expect(trace.runAgentCalls[0]?.cwd).toBe("/tmp/afk/workers/wAAAA/9-a1");

    // claim: ready-for-agent → running ; close: remove running.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+"]);
    expect(trace.closed).toEqual([9]);
    expect(trace.swept).toEqual([9]);
    // done envelope posted, live remote branch deleted on close.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    expect(trace.deletedRemote.length).toBe(1);
    // worker branch pushed before landing; claim released.
    expect(trace.pushedAttempt.length).toBe(1);
    expect(trace.released).toEqual([9]);
  });

  it("keeps a successful landing done and surfaces a local branch cleanup failure", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    deps.git.deleteLocalBranch = async () => ({ ok: false, error: "cleanup failed" }) as never;

    const result = await processIssue(deps, input);

    expect(result).toMatchObject({
      outcome: "done",
      mergeSha: "forge-merge-sha",
      cleanupError: "cleanup failed",
    });
    expect(trace.closed).toEqual([9]);
    expect(trace.swept).toEqual([9]);
    expect(trace.released).toEqual([9]);
  });

  it("fires the lifecycle hook points in order", async () => {
    const { deps, input } = harness({ outcome: "done", feedbackOk: true });
    const result = await processIssue(deps, input);
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "post_feedback",
      "pre_merge",
      "post_merge",
    ]);
  });

  it("passes the resolved default think tier model and effort into runAgent", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      resolveTier: () => ({ model: "claude-tier-model", effort: "max" }),
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-tier-model");
    expect(trace.runAgentCalls[0]?.effort).toBe("max");
  });

  it("passes the classified task class into model/effort resolution before runAgent", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      body: "## What to build\nTouch apps/dev/src/core/process-issue.ts and apps/dev/tests/process-issue.test.ts.",
      outcome: "done",
      feedbackOk: true,
      classifyIssue: async () => "complex",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: "medium" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.classifierCalls).toHaveLength(1);
    expect(trace.classifierCalls[0]?.extensions).toEqual(["ts"]);
    expect(tiers).toEqual([{ runner: "claude", taskClass: "complex" }]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-complex-model");
    expect(trace.runAgentCalls[0]?.effort).toBe("medium");
  });
});


describe("processIssue — CI-aware unlocked landing (#812)", () => {
  it("CLEAN → polls merge state then admin-merges + closes (no bounce, no re-run)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "merge" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    // exactly ONE agent run — the completed work is never re-run.
    expect(trace.runAgentCalls.length).toBe(1);
  });

  it("a FAILED required check → ci-failed, blocked:ci (NOT merge-conflict), PR preserved, agent not re-run", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "ci-failed" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-failed");
    // Truthful envelope: blocked, NEVER merge-conflict on a MERGEABLE PR.
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // Parked to ready-for-human with the distinct blocked:ci label.
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:ci"))).toBe(true);
    expect(trace.ensuredLabels).toContain("blocked:ci");
    // NEVER mislabelled merge-conflict.
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:merge-conflict"))).toBe(false);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    // The work is the durable artifact: open PR preserved (no remote branch delete),
    // issue NOT closed, agent NOT re-run.
    expect(trace.deletedRemote.length).toBe(0);
    expect(trace.closed).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
    // Never admin-merged on a failed check.
    expect(trace.released).toEqual([9]);
  });

  it("PENDING past the timeout → ci-pending, parked (NOT ready-for-agent), no token re-spend", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "ci-pending" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-pending");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // Pending NEVER recovers to ready-for-agent (which would re-run the agent).
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:ci"))).toBe(true);
    // Open PR preserved; agent ran exactly once.
    expect(trace.deletedRemote.length).toBe(0);
    expect(trace.closed).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
  });

  it("a real DIRTY conflict still classifies as merge-conflict (correct here)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, ciAware: "conflict" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:merge-conflict"))).toBe(true);
    expect(trace.runAgentCalls.length).toBe(1);
  });

  it("admin-merge rejected after PR exists parks the PR instead of re-queueing for a fresh agent", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, prMergeCode: 1 });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-failed");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:ci"))).toBe(true);
    expect(trace.closed).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.runAgentCalls.length).toBe(1);
    expect(trace.released).toEqual([9]);
  });
});


describe("processIssue — main-red-untracked landing park (#1473)", () => {
  it("red main + missing repair issue parks ready-for-human, preserves the branch, and surfaces auto-file failure", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: false,
      baselineFails: true,
      locked: false,
      mainRedRepairIssue: false,
      mainRedRepairCreateError: "gh issue create failed",
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("main-red-untracked");
    expect(result.preserved).toBe(true);
    expect(result.branch).toBe("afk/wAAAA/9-fix-the-thing");
    expect(trace.mainRedRepairCreates).toHaveLength(1);
    expect(trace.iterLogs).toContain("warn: main-red repair issue sync failed: gh issue create failed");
    expect(trace.ensuredLabels).toContain("blocked:main-red-untracked");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:main-red-untracked"))).toBe(
      true,
    );
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
    expect(trace.closed).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.pushedAttempt.length).toBe(1);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);

    const blocker = parseCurrentBlocker(trace.bodyEdits.at(-1)?.body ?? "");
    expect(blocker?.status).toBe("blocked");
    expect(blocker?.kind).toBe("main-red-untracked");
    expect(blocker?.summary).toContain("red main");
    expect(blocker?.summary).toContain("gh issue create failed");
    expect(blocker?.summary).toContain("afk/wAAAA/9-fix-the-thing");
    expect(trace.comments.at(-1)?.body).toContain("afk/wAAAA/9-fix-the-thing");
    expect(trace.comments.at(-1)?.body).toContain("gh issue create failed");
    expect(trace.released).toEqual([9]);
  });
});


describe("processIssue — per-issue manual-landing mode (landing:manual, #1049)", () => {
  function recordingMerge(deps: ProcessIssueDeps): string[][] {
    const calls: string[][] = [];
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    return calls;
  }

  it("landing:manual → full pipeline through PR creation, ZERO merge calls, parked ready-for-human", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      labels: ["ready-for-agent", "landing:manual"],
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    // The whole pipeline ran (agent + feedback) and the PR was opened/reused...
    expect(result.outcome).toBe("manual-landing");
    expect(trace.runAgentCalls.length).toBe(1);
    expect(trace.pushedAttempt.length).toBeGreaterThan(0);
    // ...but NO merge call was ever made (the seam assertion).
    expect(joined.some((c) => c.includes("pr merge"))).toBe(false);
    // No review label either — this is a human-merge hold, not a fresh-agent review.
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);

    // Parked to ready-for-human (running dropped), issue NOT closed, agent not re-run.
    expect(
      trace.labelEdits.some((e) => e.remove.includes("running") && e.add.includes("ready-for-human")),
    ).toBe(true);
    expect(trace.closed).not.toContain(9);
    // manual-landing is a handoff, NOT a failure: no blocked:* label rides along.
    expect(trace.labelEdits.some((e) => e.add.some((l: string) => l.startsWith("blocked:")))).toBe(false);
    // Open PR + worker branch preserved for the human to merge.
    expect(trace.deletedRemote).toHaveLength(0);
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    expect(trace.released).toContain(9);
  });

  it("terminal envelope carries the PR URL and names manual landing as the park reason", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      labels: ["ready-for-agent", "landing:manual"],
    });
    await processIssue(deps, input);

    // A terminal envelope was posted (folds into the generic `blocked` bucket).
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    const body = trace.envelopeBodies.join("\n");
    // The PR URL (o/r + reused PR 42) and the manual-landing reason are both present.
    expect(body).toContain("https://github.com/o/r/pull/42");
    expect(body.toLowerCase()).toContain("manual landing");
    // The auto-close back-reference is named for the human.
    expect(body).toContain("Closes #9");
    // The park comment also carries the PR URL + reason.
    expect(trace.comments.some((c) => c.body.includes("https://github.com/o/r/pull/42"))).toBe(true);
  });

  it("landing:manual holds the merge even when the direct-merge flag is set", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      worktreeLaunchesPr: false, // direct-merge mode — manual landing still opens a PR + holds
      labels: ["ready-for-agent", "landing:manual"],
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("manual-landing");
    expect(joined.some((c) => c.includes("pr merge"))).toBe(false);
    // No direct `git merge --no-ff` into the base either — nothing lands.
    expect(joined.some((c) => c.includes("merge --no-ff"))).toBe(false);
    expect(trace.closed).not.toContain(9);
  });

  it("an ordinary issue (no landing:manual) still fast-merges + closes", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      labels: ["ready-for-agent"],
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(trace.closed).toContain(9);
  });
});


describe("processIssue — landing mode decoupled from the lock (#842)", () => {
  it("locked → landMerge (merge --no-ff into the locked branch + push)", async () => {
    const calls: string[][] = [];
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, locked: true });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.locked).toBe(true);
    // landMerge issues `git -C <landing-worktree> merge --no-ff --no-verify <validated-tip> …`.
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes(`merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP}`))).toBe(true);
    // No PR list/create/merge on the locked path.
    expect(joined.some((c) => c.includes("pr list") || c.includes("pr merge"))).toBe(false);
  });

  it("unlocked → landPr (admin-merged PR into the pinned target)", async () => {
    const calls: string[][] = [];
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, locked: false });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.locked).toBe(false);
    const joined = calls.map((c) => c.join(" "));
    // landPr reuses the open PR (#42) and admin-merges it.
    expect(joined.some((c) => c.includes("pr list"))).toBe(true);
    expect(joined.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    // No direct `merge --no-ff` of the attempt branch into the locked target.
    expect(joined.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
  });

  it("locked + flag true → admin PR (no direct merge), even though locked", async () => {
    // Decoupled: a lock no longer forces a direct merge. With the default flag the
    // locked session lands via an admin-merged PR to its base (the lock branch).
    const calls: string[][] = [];
    const { deps, input } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      worktreeLaunchesPr: true,
    });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    // result.locked still echoes the lock state (observational), not the mode.
    expect(result.locked).toBe(true);
    const joined = calls.map((c) => c.join(" "));
    expect(joined.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(joined.some((c) => c.includes("merge --no-ff afk/"))).toBe(false);
  });

  it("unlocked + flag false → direct merge to main, no PR (offline)", async () => {
    // Decoupled: no lock no longer forces a PR. With the flag off the unlocked
    // session lands via a direct merge into main (no PR, offline).
    const calls: string[][] = [];
    const { deps, input } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      worktreeLaunchesPr: false,
    });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.locked).toBe(false);
    const joined = calls.map((c) => c.join(" "));
    // Direct merge of the validated attempt tip; no PR list/merge anywhere.
    expect(joined.some((c) => c.includes(`merge --no-ff --no-verify ${DEFAULT_BRANCH_TIP}`))).toBe(true);
    expect(joined.some((c) => c.includes("pr list") || c.includes("pr merge"))).toBe(false);
  });
});


describe("processIssue — PR review gate (ADR 0064 §10, #749)", () => {
  function recordingMerge(deps: ProcessIssueDeps): string[][] {
    const calls: string[][] = [];
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      calls.push(argv);
      return inner(argv);
    };
    return calls;
  }

  it("non-mechanical change → opens the PR, applies ready-for-review, parks instead of merging", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "complex",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("review-requested");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // The PR is opened/reused and labelled — firing the advisory review.
    expect(joined.some((c) => c.includes("pr edit 42 --add-label ready-for-review"))).toBe(true);
    // The merge is HELD for the fresh-agent review.
    expect(joined.some((c) => c.includes("pr merge"))).toBe(false);
    // The issue is parked to ready-for-human (running dropped) and NOT closed.
    expect(
      trace.labelEdits.some((e) => e.remove.includes("running") && e.add.includes("ready-for-human")),
    ).toBe(true);
    expect(trace.closed).not.toContain(9);
    // The worker branch is left in place (the review runs against it).
    expect(trace.deletedRemote).toHaveLength(0);
    expect(trace.released).toContain(9);
    expect(trace.comments.some((c) => c.body.includes("ready-for-review"))).toBe(true);
  });

  it("mechanical change → fast-merge path untouched (no review hop)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "simple",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);
    expect(trace.closed).toContain(9);
  });

  it("disabled gate → non-mechanical change still fast-merges", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "complex",
      // reviewGate omitted → gate off (today's behaviour).
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);
    expect(trace.closed).toContain(9);
  });

  it("locked path never opens a PR even when non-mechanical", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      classifyIssue: async () => "think",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const calls = recordingMerge(deps);
    const result = await processIssue(deps, input);
    const joined = calls.map((c) => c.join(" "));

    expect(result.outcome).toBe("done");
    expect(joined.some((c) => c.includes("--add-label ready-for-review"))).toBe(false);
    expect(trace.closed).toContain(9);
  });
});


describe("processIssue — BLOCKED", () => {
  it("flips to ready-for-human, posts a failure envelope, preserves the attempt dir", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // claim then ready-for-human + the typed blocked:spec tag; never closed.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:spec"]);
    // routing unchanged: ready-for-human still applied; typed label added alongside.
    const blockedEdit = trace.labelEdits.at(-1)!;
    expect(blockedEdit.add).toContain("ready-for-human");
    expect(blockedEdit.add).toContain("blocked:spec");
    expect(trace.ensuredLabels).toContain("blocked:spec");
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // no completion sweep, no remote delete, no land-push.
    expect(trace.swept).toEqual([]);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
    // #568: the shared terminalFailure tail must release the per-issue claim so a
    // retry-routed / re-queued issue is immediately re-claimable — it previously
    // leaked the lock until the worker process died and boot reclaimed the dir.
    expect(trace.released).toEqual([9]);
  });

  it("writes Current blocker state when a terminal blocker pages a human", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    await processIssue(deps, input);

    expect(trace.bodyEdits).toHaveLength(1);
    expect(parseCurrentBlocker(trace.bodyEdits[0]!.body)).toMatchObject({
      status: "blocked",
      kind: "spec",
      next: "Review the blocker envelope and add human guidance.",
    });
  });

  it("fires pre/post_attempt but never pre_merge on the BLOCKED path", async () => {
    const { deps, input } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });
});


describe("processIssue — no-sentinel (run ended without a <promise>)", () => {
  it("EMPTY branch → on_attempt_error → ready-for-human, no post_attempt", async () => {
    // No work on the branch: a real crash, kept as today's terminal no-sentinel.
    const { deps, input, trace } = harness({ outcome: "no-sentinel", changedFiles: [] });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:crashed"]);
    const nsEdit = trace.labelEdits.at(-1)!;
    expect(nsEdit.add).toContain("ready-for-human");
    expect(nsEdit.add).toContain("blocked:crashed");
    expect(trace.ensuredLabels).toContain("blocked:crashed");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "no-sentinel" }]);
    expect(trace.statePatches).toContainEqual({
      "current.phase": "terminal",
      "current.outcome": "no-sentinel",
      "current.last_exit_code": 1,
      "current.failure_kind": "crash",
    });
    // on_attempt_error fires; post_attempt does NOT (ADR 0028).
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "on_attempt_error"]);
    // #568: the no-sentinel terminal also releases the per-issue claim.
    expect(trace.released).toEqual([9]);
  });

  it("preserves an earlier actionable blocker when a later empty no-sentinel crashes (#862)", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "merge-conflict",
      summary: "Attempt 1 preserved a merge-conflict branch.",
      next: "Resolve the merge conflict or add guidance for the next agent attempt.",
    });
    const { deps, input, trace } = harness({ outcome: "no-sentinel", changedFiles: [], body });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    // Byte-exact editing: the body already canonically carries the actionable
    // merge-conflict blocker, so preservation is a no-op write rather than a
    // re-render. What matters is that the generic runner blocker never clobbers
    // it — assert no edit overwrites the merge-conflict blocker.
    const clobbered = trace.bodyEdits.some(
      (edit) =>
        edit.body.includes("Review the attempt log and decide whether to retry") ||
        parseCurrentBlocker(edit.body)?.kind === "runner",
    );
    expect(clobbered).toBe(false);
    // The merge-conflict blocker survives in the (unchanged) issue body.
    expect(parseCurrentBlocker(body)).toMatchObject({
      kind: "merge-conflict",
      summary: "Attempt 1 preserved a merge-conflict branch.",
      next: "Resolve the merge conflict or add guidance for the next agent attempt.",
    });
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "no-sentinel" }]);
  });

  it("branch carries work + passes feedback → SALVAGE: lands like DONE, closes (issue #332)", async () => {
    // The agent finished + committed but exited without the sentinel (the #300
    // loop). Branch is ahead of base and green → salvage through the same gate.
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done"); // salvaged → lands exactly like a DONE attempt
    expect(result.mergeSha).toBe("abc1234");
    expect(result.swept).toBe(true);
    expect(trace.closed).toEqual([9]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    // post_attempt(success) + the full land tail fire; on_attempt_error does NOT.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "post_feedback",
      "pre_merge",
      "post_merge",
    ]);
  });

  it("branch carries work but FAILS feedback → feedback-failed, never merged, not an error", async () => {
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.closed).toEqual([]);
    expect(result.hooksFired).not.toContain("on_attempt_error");
  });

  it("salvaged branch passes feedback but FAILS backpressure → parked like a feedback fail, never merged (#432)", async () => {
    // #432: a no-sentinel attempt salvaged through the gate (branch carries work +
    // feedback green) is held to the SAME backpressure bar as a DONE attempt — a
    // failing operator command blocks the merge and parks to ready-for-human, and
    // it is NOT an error. The gate already lives in the shared DONE/salvage tail
    // (#430); this locks that coverage in.
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.closed).toEqual([]);
    expect(labelTrace(trace)).toEqual([
      "-ready-for-agent|+running",
      "-running|+ready-for-human+blocked:validation",
    ]);
    expect(trace.pushedAttempt).toEqual([]);
    expect(result.hooksFired).not.toContain("on_attempt_error");
    const lastSidecar = trace.sidecarWrites.at(-1)!;
    const bp = lastSidecar.lines
      .map((l) => JSON.parse(l) as { name: string; status: string })
      .find((r) => r.name === "backpressure:npm run e2e")!;
    expect(bp.status).toBe("failed");
  });

  it("salvaged branch merges + closes when feedback AND backpressure both pass (#432)", async () => {
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done"); // salvaged + both gates green → lands like DONE
    expect(trace.closed).toEqual([9]);
  });

  it("exposes the configured backpressure command to the inner-agent handoff as the binding <merge-gate> (#849)", async () => {
    // Acceptance #849: the inner agent must SEE the exact orchestrator gate it
    // has to satisfy before DONE, not discover it only when the post-DONE
    // backpressure gate bounces it as blocked:validation.
    const { deps, input, trace } = harness({
      outcome: "done",
      backpressureCommands: ["cargo fmt --all -- --check", "npm run e2e"],
      backpressureOk: true,
    });
    await processIssue(deps, input);

    const handoff = trace.runAgentCalls[0]?.handoffContent ?? "";
    expect(handoff).toContain("<merge-gate>");
    expect(handoff).toContain("- cargo fmt --all -- --check");
    expect(handoff).toContain("- npm run e2e");
  });

  it("omits <merge-gate> from the handoff when no backpressure command is configured (#849)", async () => {
    const { deps, input, trace } = harness({ outcome: "done" });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.handoffContent ?? "").not.toContain("<merge-gate>");
  });

  it("alternates output-shaping steering by issue and stamps the measurement arm (#1638)", async () => {
    const steered = harness({ outcome: "done", outputShaping: { terseSteering: true } });
    steered.input.issue = 10;
    await processIssue(steered.deps, steered.input);
    expect(steered.trace.runAgentCalls[0]?.handoffContent ?? "").toContain("<output-shaping>");
    expect(steered.trace.statePatches).toContainEqual({
      "current.output_shaping_enabled": true,
      "current.output_shaping_variant": "steered",
    });

    const holdout = harness({ outcome: "done", outputShaping: { terseSteering: true } });
    holdout.input.issue = 9;
    await processIssue(holdout.deps, holdout.input);
    expect(holdout.trace.runAgentCalls[0]?.handoffContent ?? "").not.toContain("<output-shaping>");
    expect(holdout.trace.statePatches).toContainEqual({
      "current.output_shaping_enabled": true,
      "current.output_shaping_variant": "holdout",
    });
  });

  it("posts ONE aggregated non-blocking backpressure review on the PR, the merge/close unchanged (#1279)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    // Merge/close decision is byte-for-byte the pre-#1279 behaviour.
    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);

    // Exactly ONE aggregated COMMENT review, on the landed PR (#42), all-green.
    expect(trace.backpressureReviews).toHaveLength(1);
    const review = trace.backpressureReviews[0]!;
    expect(review.pr).toBe(42);
    expect(review.body).toContain("✅ backpressure:npm run e2e");
    // In-band statement that the ledger is non-blocking observability.
    expect(review.body).toContain("non-blocking");
    expect(review.body).not.toMatch(/APPROVE|REQUEST_CHANGES/);
  });

  it("posts NO review when no backpressure command is configured — an empty ledger is never a review (#1279)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    expect(trace.backpressureReviews).toEqual([]);
  });

  it("a FAILED backpressure command parks blocked:validation exactly as before, posting no review (no-new-blocking, #1279)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
      locked: false,
    });
    const result = await processIssue(deps, input);

    // The park is the pre-#1279 behaviour: blocked:validation, never merged.
    expect(result.outcome).toBe("feedback-failed");
    expect(labelTrace(trace)).toEqual([
      "-ready-for-agent|+running",
      "-running|+ready-for-human+blocked:validation",
    ]);
    expect(trace.pushedAttempt).toEqual([]);
    // The failing gate blocks BEFORE any PR is opened → no surface to attach the
    // ledger to; the review path fires nothing and cannot change the park.
    expect(trace.backpressureReviews).toEqual([]);
  });
});


describe("processIssue — advisory adversarial review (#2207)", () => {
  it("default-off path lands without running the adversarial reviewer", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    expect(trace.adversarialReviewContexts).toEqual([]);
    expect(trace.adversarialReviews).toEqual([]);
  });

  it("enabled path reviews diff plus Issue only, comments on PR and Issue, then still lands", async () => {
    const issueBody = [
      "## Agent brief",
      "Implement the tracer.",
      "",
      "## Acceptance criteria",
      "- [ ] Post review findings to the PR and Issue.",
    ].join("\n");
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      body: issueBody,
      adversarialReview: { enabled: true, maxIterations: 2, reviewerCount: 1, quorum: "any" },
      adversarialFindings: {
        summary: "Stubbed adversarial review summary.",
        findings: [
          {
            path: "packages/x/src/a.ts",
            line: 1,
            body: "Acceptance criteria conformance finding.",
            blocking: false,
          },
        ],
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    expect(trace.adversarialReviewContexts).toHaveLength(1);
    expect(trace.adversarialReviewContexts[0]).toMatchObject({
      issueNumber: 9,
      issueTitle: "Fix the thing",
      issueBody,
      prNumber: 42,
      maxIterations: 2,
    });
    expect(trace.adversarialReviewContexts[0]?.diff).toContain("diff --git");
    expect(trace.adversarialReviews).toHaveLength(1);
    const body = trace.adversarialReviews[0]?.body ?? "";
    expect(body).toContain("AFK adversarial review");
    expect(body).toContain("Decision: pass (advisory)");
    expect(body).toContain("blocking: false");
    expect(body).toContain("Acceptance criteria conformance finding.");
    expect(trace.comments).toContainEqual({ issue: 42, body });
    expect(trace.comments).toContainEqual({ issue: 9, body });
  });

  it("blocking finding re-seeds the implementer with diff plus critiques, then clean review lands (#2208)", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["done", "done"],
      feedbackOk: true,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialFindingsSequence: [
        {
          summary: "One blocking acceptance gap.",
          findings: [
            {
              path: "packages/x/src/a.ts",
              line: 1,
              body: "The implementation does not satisfy the acceptance criterion.",
              blocking: true,
            },
            {
              path: "packages/x/src/a.ts",
              line: 1,
              body: "Prefer a clearer name.",
              blocking: false,
            },
          ],
        },
        {
          summary: "Clean after correction.",
          findings: [],
        },
      ],
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.adversarialReviewContexts).toHaveLength(2);
    expect(trace.closed).toEqual([9]);

    const retryHandoff = trace.runAgentCalls[1]?.handoffContent ?? "";
    expect(retryHandoff).toContain("<adversarial-review-correction>");
    expect(retryHandoff).toContain("bounded correction retry 1/1");
    expect(retryHandoff).toContain("The implementation does not satisfy the acceptance criterion.");
    expect(retryHandoff).not.toContain("Prefer a clearer name.");
    expect(retryHandoff).toContain("<pr-diff data-untrusted=\"true\">");
    expect(retryHandoff).toContain("diff --git");

    expect(trace.adversarialReviews[0]?.body).toContain("Decision: correct (blocking)");
    expect(trace.adversarialReviews[1]?.body).toContain("Decision: pass (advisory)");
    expect(trace.iterLogs.some((line) => line.includes("correction retry 1/1"))).toBe(true);
  });

  it("non-blocking findings stay advisory and do not re-seed the implementer (#2208)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialFindings: {
        summary: "Only suggestions.",
        findings: [
          {
            path: "packages/x/src/a.ts",
            line: 1,
            body: "Consider shorter wording.",
            blocking: false,
          },
        ],
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.adversarialReviewContexts).toHaveLength(1);
    expect(trace.closed).toEqual([9]);
    expect(trace.adversarialReviews[0]?.body).toContain("Decision: pass (advisory)");
  });

  it("runs configured reviewer count and applies quorum with reviewer runner resolution (#2210)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "validate",
      resolveTier: (runner, taskClass) => {
        if (runner === "codex" && taskClass === "validate") {
          return { model: "gpt-review", effort: "low" };
        }
        return { model: "claude-opus-4-8", effort: "high" };
      },
      adversarialReview: {
        enabled: true,
        maxIterations: 1,
        reviewerCount: 2,
        quorum: 2,
        runner: "codex",
      },
      adversarialFindingsSequence: [
        {
          summary: "First reviewer found a bug.",
          findings: [
            {
              path: "packages/x/src/a.ts",
              line: 1,
              body: "Quorum-only blocking defect.",
              blocking: true,
            },
          ],
        },
        {
          summary: "Second reviewer found no bug.",
          findings: [],
        },
      ],
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.adversarialReviewContexts).toHaveLength(2);
    expect(trace.adversarialReviewContexts.map(({ runner, model, effort }) => ({ runner, model, effort }))).toEqual([
      { runner: "codex", model: "gpt-review", effort: "low" },
      { runner: "codex", model: "gpt-review", effort: "low" },
    ]);
    expect(trace.adversarialReviews).toHaveLength(1);
    expect(trace.adversarialReviews[0]?.body).toContain("Decision: pass (advisory)");
    expect(trace.adversarialReviews[0]?.body).toContain("blocking: false");
    expect(trace.closed).toEqual([9]);
  });

  it("raised review budget parks ready-for-human when blocking findings remain at exhaustion (#2209)", async () => {
    const blocking = {
      summary: "Blocking acceptance gaps remain.",
      findings: [
        {
          path: "packages/x/src/a.ts",
          line: 1,
          body: "The implementation still omits the required audit trail.",
          blocking: true,
        },
      ],
    };
    const { deps, input, trace } = harness({
      outcomes: ["done", "done", "done"],
      feedbackOk: true,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 2, reviewerCount: 1, quorum: "any" },
      adversarialFindingsSequence: [blocking, blocking, blocking],
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(3);
    expect(trace.adversarialReviewContexts).toHaveLength(3);
    expect(trace.closed).toEqual([]);
    expect(labelTrace(trace)).toContain("-running|+ready-for-human+blocked:validation");
    expect(trace.adversarialReviews[0]?.body).toContain("Decision: correct (blocking)");
    expect(trace.adversarialReviews[1]?.body).toContain("Decision: correct (blocking)");
    expect(trace.adversarialReviews[2]?.body).toContain("Decision: park (blocking)");

    const blocker = parseCurrentBlocker(trace.bodyEdits.at(-1)?.body ?? "");
    expect(blocker).toMatchObject({
      status: "blocked",
      kind: "validation",
      summary: expect.stringContaining("packages/x/src/a.ts:1"),
      next: expect.stringContaining("Decide whether to fix forward"),
    });
    expect(blocker?.summary).toContain("The implementation still omits the required audit trail.");
    expect(trace.envelopeBodies.at(-1)).toContain("Adversarial review budget exhausted");
  });
});


describe("processIssue — commit-leftovers salvage (codex DONE-without-commit)", () => {
  it("DONE but zero commits → salvages the dirty worktree, then lands + closes like a normal DONE", async () => {
    // The codex symptom: the inner agent edits, passes the gates, emits DONE, but
    // never commits — sandcastle collects zero commits. Salvage commits the
    // worktree so the feedback gate + landing see the work.
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      salvage: 5,
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    // The salvage port was asked to commit the worktree of the live worker branch.
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.salvageCalls[0]).toMatch(/^afk\/wAAAA\//);
    expect(trace.salvageCalls[0]).toBe(result.branch);
    expect(result.outcome).toBe("done"); // salvaged → lands + closes like DONE
    expect(trace.closed).toContain(9);
  });

  it("DONE with commits + clean worktree → probes salvage but creates no extra salvage log", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      salvage: 0,
      feedbackOk: true,
    });
    await processIssue(deps, input);
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.iterLogs.some((line) => line.includes("salvaged"))).toBe(false);
  });

  it("DONE with commits + dirty leftovers → salvages the remaining work before validation", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      salvage: 2,
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.iterLogs.some((line) => line.includes("left dirty worktree paths after 1 commit(s)"))).toBe(true);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
  });

  it("DONE but zero commits + salvaged dirty worktree + feedback fail explains both facts", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      salvage: 1,
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.salvageCalls).toHaveLength(1);
    expect(trace.iterLogs.some((line) => line.includes("salvaged 1 uncommitted file(s)"))).toBe(true);
    const body = trace.envelopeBodies.at(-1) ?? "";
    expect(body).toContain("Inner agent emitted done with zero commits");
    expect(body).toContain("AFK salvaged 1 uncommitted file(s)");
    expect(body).toContain("feedback validation failed");
  });

  it("DONE with commits + salvaged leftovers + feedback fail explains partial dirty state", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      salvage: 1,
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    const body = trace.envelopeBodies.at(-1) ?? "";
    expect(body).toContain("after 1 commit(s) and left dirty worktree paths");
    expect(body).toContain("AFK salvaged 1 uncommitted file(s)");
    expect(body).toContain("feedback validation failed");
  });

  it("no-sentinel + zero commits → salvage runs; a clean worktree (0 files) stays the empty-branch terminal", async () => {
    // Salvage returns 0 (clean worktree) → the no-sentinel branch carries no work
    // → today's terminal no-sentinel behaviour is preserved (ready-for-human).
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      commits: [],
      salvage: 0,
      changedFiles: [],
    });
    const result = await processIssue(deps, input);
    expect(trace.salvageCalls).toHaveLength(1);
    expect(result.outcome).toBe("no-sentinel");
  });

  it("legacy caller (no salvage port) keeps today's behaviour on a zero-commit DONE", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      // salvage omitted → port absent
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);
    expect(trace.salvageCalls).toEqual([]);
    expect(result.outcome).toBe("done");
  });
});


describe("processIssue — active Current blocker preflight", () => {
  it("moves the issue back to ready-for-human without starting an attempt", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "decision",
      ref: "#856",
      summary: "Measurement did not prove a win.",
      next: "Decide whether to stop, redesign, or continue anyway.",
    });
    const { deps, input, trace } = harness({ body });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(result.preserved).toBe(false);
    expect(result.swept).toBe(false);
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([]);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+ready-for-human+blocked:spec"]);
    expect(trace.comments[0]?.body).toContain("active Current blocker (decision)");
    expect(trace.released).toEqual([9]);
  });

  it("parks a MIXED-BLOCKED issue cleanly instead of crashing the worker (#1481)", async () => {
    // An illegal mixed-blocked issue: ready-for-agent dragging a stale
    // blocked:validation, with an active non-mechanical Current blocker so
    // preflight decides to park. Before #1481 the preflight-blocked transition
    // classified the start state as `illegal`, found no legal row, and killed the
    // worker with an uncaught session-error. Now it reconciles: sheds every stale
    // blocked:* in the same park edit and lands cleanly on ready-for-human.
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "decision",
      ref: "#856",
      summary: "Measurement did not prove a win.",
      next: "Decide whether to stop, redesign, or continue anyway.",
    });
    const { deps, input, trace } = harness({
      body,
      labels: ["ready-for-agent", "blocked:validation"],
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(trace.runAgentCalls).toEqual([]);
    const parkEdit = trace.labelEdits.at(-1)!;
    // Stale blocked:validation shed AND ready-for-agent removed in the same edit.
    expect(parkEdit.remove).toContain("ready-for-agent");
    expect(parkEdit.remove).toContain("blocked:validation");
    // Parks to a clean human gate with the blocking-reason label.
    expect(parkEdit.add).toContain("ready-for-human");
    expect(parkEdit.add).toContain("blocked:spec");
    expect(trace.released).toEqual([9]);
  });

  it("does not escalate a mechanical Current blocker before reconcile can handle it", async () => {
    const body = upsertCurrentBlocker("## Agent brief\nDo it.", {
      status: "blocked",
      kind: "stalled",
      summary: "Worker stopped after pushing a branch.",
      next: "Reconcile the owned branch.",
    });
    const { deps, input, trace } = harness({
      body,
      labels: ["ready-for-agent", "blocked:stalled"],
      outcome: "done",
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls.length).toBe(1);
    expect(labelTrace(trace)[0]).toBe("-ready-for-agent+blocked:stalled|+running");
    expect(trace.comments.map((c) => c.body).some((body) => body.includes("preflight stopped"))).toBe(false);
    expect(trace.ensuredLabels).not.toContain("blocked:spec");
  });
});
