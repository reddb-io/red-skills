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
import { reseedParkMarker } from "../src/core/process-issue/reseed-trail.js";
import { encodeLines } from "@reddb-io/toon";
import { vi } from "vitest";
describe("processIssue — DONE + green + merged (unlocked, admin-PR landing)", () => {
  describe("landing.wait slot release (#2427)", () => {
    type DeferredTail = {
      prNumber: number;
      waitForCi: boolean;
      run(): Promise<unknown>;
    };

    function recordMergeCalls(deps: ProcessIssueDeps): string[] {
      const calls: string[] = [];
      const inner = deps.mergeExec;
      deps.mergeExec = async (argv) => {
        calls.push(argv.join(" "));
        return inner(argv);
      };
      return calls;
    }

    it("defaults to merge and preserves the synchronous merge → close → release flow", async () => {
      const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false });
      const calls = recordMergeCalls(deps);
      let observed = false;
      Object.assign(deps, {
        landingTailObserver: async () => {
          observed = true;
          throw new Error("default merge mode must not hand off");
        },
      });

      const result = await processIssue(deps, input);

      expect(result).toMatchObject({ outcome: "done", swept: true });
      expect(observed).toBe(false);
      expect(calls.some((call) => call.includes("pr merge 42 --merge"))).toBe(true);
      expect(trace.closed).toEqual([9]);
      expect(trace.released).toEqual([9]);
    });

    it("landing.wait=ci releases after green CI and lets the observer merge and close", async () => {
      const { deps, input, trace } = harness({
        outcome: "done",
        feedbackOk: true,
        locked: false,
        ciAware: "merge",
      });
      const calls = recordMergeCalls(deps);
      let tail!: DeferredTail;
      let releaseTail!: () => void;
      const tailGate = new Promise<void>((resolve) => {
        releaseTail = resolve;
      });
      let completion!: Promise<unknown>;
      Object.assign(deps, {
        landingWait: "ci",
        landingTailObserver: (task: DeferredTail) => {
          tail = task;
          completion = tailGate.then(() => task.run());
          return completion;
        },
      });

      const result = await processIssue(deps, input);

      expect(result).toMatchObject({ outcome: "done", swept: false });
      expect(tail).toMatchObject({ prNumber: 42, waitForCi: false });
      expect(calls.some((call) => call.includes("--json mergeStateStatus"))).toBe(true);
      expect(calls.some((call) => call.includes("pr merge 42 --merge"))).toBe(false);
      expect(trace.closed).toEqual([]);
      expect(trace.released).toEqual([9]);

      releaseTail();
      await completion;
      await vi.waitFor(() => expect(trace.closed).toEqual([9]));
      expect(calls.some((call) => call.includes("pr merge 42 --merge"))).toBe(true);
    });

    it("landing.wait=none releases as soon as the PR resolves and the observer waits, merges, and closes", async () => {
      const { deps, input, trace } = harness({
        outcome: "done",
        feedbackOk: true,
        locked: false,
        ciAware: "merge",
      });
      const calls = recordMergeCalls(deps);
      let tail!: DeferredTail;
      let releaseTail!: () => void;
      const tailGate = new Promise<void>((resolve) => {
        releaseTail = resolve;
      });
      let completion!: Promise<unknown>;
      Object.assign(deps, {
        landingWait: "none",
        landingTailObserver: (task: DeferredTail) => {
          tail = task;
          completion = tailGate.then(() => task.run());
          return completion;
        },
      });

      const result = await processIssue(deps, input);

      expect(result).toMatchObject({ outcome: "done", swept: false });
      expect(tail).toMatchObject({ prNumber: 42, waitForCi: true });
      expect(calls.some((call) => call.includes("--json mergeStateStatus"))).toBe(false);
      expect(calls.some((call) => call.includes("pr merge 42 --merge"))).toBe(false);
      expect(trace.closed).toEqual([]);
      expect(trace.released).toEqual([9]);

      releaseTail();
      await completion;
      await vi.waitFor(() => expect(trace.closed).toEqual([9]));
      expect(calls.some((call) => call.includes("pr merge 42 --merge"))).toBe(true);
    });
  });

  it("pre-cleans a merge-conflict retry branch before sandcastle can reuse a stale worktree", async () => {
    const prevFailureContext = [
      "prev-envelope: https://github.com/o/r/issues/9",
      "prev-failure-reason:",
      "merge-conflict",
    ].join("\n");
    const { deps, input, trace } = harness({
      attempt: 2,
      prevFailureContext,
      outcome: "done",
      feedbackOk: true,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.freshWorkerBranchCalls).toEqual([
      {
        branch: "afk/9-fix-the-thing",
        baseRef: "granted-fork-sha",
        force: true,
      },
    ]);
    expect(trace.runAgentCalls[0]?.base).toBe("granted-fork-sha");
    expect(trace.handoffs[0]?.content).toContain("prev-envelope: https://github.com/o/r/issues/9");
    expect(trace.handoffs[0]?.content).toContain("prev-failure-reason:\nmerge-conflict");
  });

  it("keeps non-conflict same-run reuse eligible for the stale-base check only", async () => {
    const prevFailureContext = [
      "prev-envelope: https://github.com/o/r/issues/9",
      "prev-failure-reason:",
      "validation failed",
    ].join("\n");
    const { deps, input, trace } = harness({
      attempt: 2,
      prevFailureContext,
      outcome: "done",
      feedbackOk: true,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.freshWorkerBranchCalls).toEqual([
      {
        branch: "afk/9-fix-the-thing",
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
    expect(result.branch).toBe("afk/9-fix-the-thing");
    expect(result.base).toBe("main");
    expect(result.locked).toBe(false);
    expect(result.mergeSha).toBe("forge-merge-sha");
    expect(result.swept).toBe(true);

    // sandcastle ran once, on the worker branch, with the handoff as promptFile.
    expect(trace.runAgentCalls.length).toBe(1);
    expect(trace.runAgentCalls[0]?.branch).toBe("afk/9-fix-the-thing");
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

  it("falls back to the standard simple tier when classification is unavailable", async () => {
    const tiers: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      classifyIssue: async () => {
        throw new Error("classifier unavailable");
      },
      resolveTier: (_runner, taskClass) => {
        tiers.push(taskClass ?? "missing");
        return { model: `claude-${taskClass}-model`, effort: "high" };
      },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(tiers).toEqual(["simple"]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-simple-model");
  });

  it("records the resolved routing decision in the worker lane before spawn", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      classifyIssue: async () => "complex",
      resolveTier: () => ({ model: "claude-complex-model", effort: "medium" }),
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.iterLogs).toContain(
      "🤖 /afk route #9: tier=complex runner=claude model=claude-complex-model effort=medium.",
    );
    expect(trace.statePatches).toContainEqual({
      "current.runner": "claude",
      "current.model_tier": "complex",
      "current.model": "claude-complex-model",
      "current.effort": "medium",
    });
    expect(trace.workerEvents).toContainEqual({
      kind: "worker.routed",
      payload: {
        runner: "claude",
        model_tier: "complex",
        model: "claude-complex-model",
        effort: "medium",
      },
    });
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
    expect(trace.sidecarWrites.at(-1)?.lines.some((line) => line.includes("post-merge:satisfied-by-ci"))).toBe(true);
    expect(trace.workerEvents.some((event) => event.kind === "worker.post_merge_validation" && event.payload?.path === "satisfied-by-ci")).toBe(true);
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

  it("a post-merge-gate failure parks blocked:validation, NEVER merge-conflict (#2339)", async () => {
    // #2338 field report: the gate could not materialise its worktree, every
    // check short-circuited with `durationMs: 0`, and the attempt was parked as
    // blocked:merge-conflict — sending humans down the wrong recovery path even
    // though the pre-merge rebase had already succeeded (same class as #2096).
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      postMergeGateOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:validation"))).toBe(true);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:merge-conflict"))).toBe(false);
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    // The work is preserved: nothing merged, agent not re-run.
    expect(trace.closed).toEqual([]);
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

  it("a rejected merge records the OBSERVED reason and never sends a human after an unverified failing check (#2807)", async () => {
    // Field trace: PRs #2803 / #2806 were green, mergeable, and CLEAN; the base
    // had merely advanced. The blocker still read "usually because branch
    // protection or CI is not satisfied" and told a human to fix a check that
    // did not exist.
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, locked: false, prMergeCode: 1 });
    await processIssue(deps, input);

    const written = [...trace.bodyEdits.map((e) => e.body), ...trace.comments.map((c) => c.body)].join("\n");
    expect(written).not.toMatch(/usually|probably/i);
    expect(written).not.toContain("Fix the failing required check");
    const blocker = trace.bodyEdits.at(-1)?.body ?? "";
    expect(blocker).toContain("Read the recorded rejection reason");
  });
});


describe("processIssue — baseline comparison is comparison-only (#2380)", () => {
  it("a branch failure reproduced on the baseline parks blocked:validation and files NO repair issue", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: false,
      baselineFails: true,
      locked: false,
    });

    const result = await processIssue(deps, input);

    // The verdict is inconclusive, so the branch parks on its own validation
    // failure — it never lands, and it never becomes anyone else's land block.
    expect(result.outcome).toBe("feedback-failed");
    expect(trace.ensuredLabels).not.toContain("blocked:main-red-untracked");
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:validation"))).toBe(true);
    // Nothing tracked: the retired repair lane files no issue for a red
    // baseline — the gh surface has no create/find repair hook left to call.
    expect(trace.comments.some((c) => c.body.includes("main-red repair"))).toBe(false);
    expect(trace.closed).toEqual([]);
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

  // #2936: the PR used to be born on the boot-time base — `pushAttempt` was
  // followed straight by `openReviewPr`, with no fetch and no conflict check
  // between them. A base that moved therefore only surfaced at landing time,
  // with the worker dead and a human holding a dirty PR (PRs #2933, #2934).
  it("integrates origin/<base> into the branch BEFORE opening the review PR", async () => {
    const { deps, input } = harness({
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
    const integrated = joined.findIndex((c) => c === "git -C /rwt merge --no-edit origin/main");
    const published = joined.findIndex((c) => c.startsWith("git -C /rwt push origin HEAD:refs/heads/"));
    const prCreated = joined.findIndex((c) => c.includes("pr create"));
    expect(joined).toContain("git -C /rwt fetch origin main --quiet");
    expect(integrated).toBeGreaterThan(-1);
    expect(published).toBeGreaterThan(integrated);
    expect(prCreated).toBeGreaterThan(published);
  });

  it("a base that moved into a conflict parks merge-conflict instead of opening a stale PR", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "complex",
      reviewGate: { enabled: true, threshold: "complex" },
    });
    const inner = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      const j = argv.join(" ");
      // The moved base conflicts with the worker's slice.
      if (j === "git -C /rwt merge --no-edit origin/main") return { code: 1, stdout: "", stderr: "" };
      if (j === "git -C /rwt diff --name-only --diff-filter=U") {
        return { code: 0, stdout: "shared.ts\n", stderr: "" };
      }
      return inner(argv);
    };
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    // The conflict is reported HERE, naming the files, while a retry can still
    // resolve it — not inherited by a human at landing time.
    expect(trace.envelopeBodies.some((b) => b.includes("shared.ts"))).toBe(true);
    expect(trace.envelopeBodies.some((b) => b.includes("BEFORE the pull request was opened"))).toBe(true);
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
  it("surfaces a sandbox setup failure from the structured Worker log when runner stdout is empty", async () => {
    const { deps, input, trace } = harness({ outcome: "no-sentinel", changedFiles: [] });
    deps.workerLogPath = "/worker/worker.log.toonl";
    const lane = encodeLines();
    Object.assign(deps.fs, {
      readText: async (path: string) => {
        expect(path).toBe(deps.workerLogPath);
        return lane.push({ at: "2026-08-04T00:00:00Z", kind: "worker.heartbeat", msg: "iteration started" })
          + lane.push({ at: "2026-08-04T00:00:01Z", kind: "worker.log", msg: "Setting up sandbox" })
          + lane.push({ at: "2026-08-04T00:00:02Z", kind: "worker.log", msg: 'Command failed in sandbox (git config --global user.name "Worker"): Command failed (exit 255)' })
          + lane.push({ at: "2026-08-04T00:00:03Z", kind: "worker.log", msg: "error: could not lock config file [REDACTED_HOME]/.gitconfig: File exists" });
      },
    });
    deps.runAgent = async (runInput) => ({
      outcome: "no-sentinel",
      branch: runInput.branch,
      commits: [],
      stdout: "",
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    expect(parseCurrentBlocker(trace.bodyEdits.at(-1)!.body)).toMatchObject({
      kind: "runner",
      summary: expect.stringContaining("Command failed in sandbox"),
    });
    expect(trace.envelopeBodies.at(-1)).toContain("Command failed in sandbox");
  });

  it("worker crash before Landing never snapshots or integrates the primary checkout", async () => {
    // No work on the branch: a real crash while the operator may have unrelated
    // dirty primary WIP. The attempt must terminate before every Landing git/
    // forge call; in particular it cannot stage or commit a primary snapshot.
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
    expect(trace.mergeCalls).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
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
    expect(result.mergeSha).toBe("forge-merge-sha");
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

  it("uses feedback.commands as the exact local feedback stage and worker contract (#3276)", async () => {
    const command = "pnpm -C apps/dev exec tsc --noEmit";
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackCommands: [command],
      locked: false,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.pnpmArgs).toEqual([]);
    expect(trace.shellCommands.length).toBeGreaterThan(0);
    expect(trace.shellCommands.every((entry) => entry === command)).toBe(true);
    const handoff = trace.runAgentCalls[0]?.handoffContent ?? "";
    expect(handoff).toContain("<merge-gate>");
    expect(handoff).toContain(`- ${command}`);
  });

  it("skips undeclared post_done and landing moments without discovering local commands", async () => {
    const { deps, input, trace } = harness({ outcome: "done", locked: false });
    deps.validationMoments = {};

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.pnpmArgs).toEqual([]);
    expect(trace.shellCommands).toEqual([]);
    expect(trace.iterLogs).toContain("🤖 /afk validation moment post_done skipped: undeclared.");
    expect(trace.iterLogs).toContain("🤖 /afk validation moment landing skipped: undeclared.");
    expect(trace.envelopeBodies.at(-1) ?? "").toContain('"name":"validation:post_done","status":"skipped"');
    expect(trace.envelopeBodies.at(-1) ?? "").toContain('"name":"validation:landing","status":"skipped"');
    expect(trace.runAgentCalls[0]?.handoffContent ?? "").toContain("Run nothing heavy mid-write");
  });

  it("carries declared iteration commands into the inner-agent handoff", async () => {
    const { deps, input, trace } = harness({ outcome: "done", locked: false });
    deps.validationMoments = {
      iteration: ["pnpm test:unit", "pnpm typecheck"],
    };

    await processIssue(deps, input);

    const handoff = trace.runAgentCalls[0]?.handoffContent ?? "";
    expect(handoff).toContain("<iteration>");
    expect(handoff).toContain("- pnpm test:unit");
    expect(handoff).toContain("- pnpm typecheck");
  });

  it("runs declared post_done at the branch fork point even when the live base moves", async () => {
    const command = "pnpm test:fork-point";
    const { deps, input, trace } = harness({
      outcome: "done",
      locked: false,
    });
    deps.validationMoments = { post_done: [command] };

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.shellCommands).toEqual([command]);
    expect(trace.workerBaseMovementCalls).toEqual([]);
    expect(trace.changedFileCalls[0]?.base).toBe("granted-fork-sha");
  });

  it("re-runs only the failed post_done subset, then folds back to the full declaration", async () => {
    const commands = ["pnpm test:a", "pnpm test:b"];
    const { deps, input, trace } = harness({ outcome: "done", reseedGateBudget: 1, locked: false });
    deps.validationMoments = { post_done: commands };
    let call = 0;
    let clock = 0;
    deps.nowEpoch = () => (clock += 1000);
    deps.backpressure = async ({ command }) => {
      trace.shellCommands.push(command);
      call += 1;
      return {
        code: call === 1 ? 1 : 0,
        stdout: call === 1 ? "a failed" : "",
        stderr: "",
      };
    };

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.shellCommands).toEqual([
      "pnpm test:a",
      "pnpm test:b",
      "pnpm test:a",
      "pnpm test:a",
      "pnpm test:b",
    ]);
    expect(trace.iterLogs).toContain(
      "🤖 /afk validation moment post_done correction subset passed; folding back to the full declaration.",
    );
  });

  it("runs a declared landing moment before push and PR creation", async () => {
    const events: string[] = [];
    const { deps, input, trace } = harness({ outcome: "done", locked: false });
    deps.validationMoments = { landing: ["pnpm test:landing"] };
    const shellExec = deps.backpressure!;
    deps.backpressure = async (request) => {
      events.push(`validation:${request.command}`);
      return shellExec(request);
    };
    const remoteGit = deps.remoteGit;
    deps.remoteGit = async (argv) => {
      events.push(`push:${argv.join(" ")}`);
      return remoteGit(argv);
    };
    const mergeExec = deps.mergeExec;
    deps.mergeExec = async (argv) => {
      if (argv.includes("pr") && argv.includes("create")) events.push("pr:create");
      return mergeExec(argv);
    };

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(events[0]).toBe("validation:pnpm test:landing");
    expect(events.indexOf("validation:pnpm test:landing")).toBeLessThan(events.findIndex((event) => event.startsWith("push:")));
    expect(events.indexOf("validation:pnpm test:landing")).toBeLessThan(events.indexOf("pr:create"));
    expect(trace.shellCommands).toEqual(["pnpm test:landing"]);
  });

  it("omits <merge-gate> from the handoff when no backpressure command is configured (#849)", async () => {
    const { deps, input, trace } = harness({ outcome: "done" });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.handoffContent ?? "").not.toContain("<merge-gate>");
  });

  it("injects repository enrichment and silently keeps the base handoff when discovery fails (#2402)", async () => {
    const enriched = harness({ outcome: "done" });
    enriched.deps.lookups.handoffEnrichment = async (metadata) => {
      expect(metadata).toMatchObject({ issue: 9, labels: ["ready-for-agent"], title: "Fix the thing" });
      return "context:\n  name: Dev";
    };
    await processIssue(enriched.deps, enriched.input);
    expect(enriched.trace.runAgentCalls[0]?.handoffContent ?? "").toContain(
      "<handoff-enrichment>\ncontext:\n  name: Dev\n</handoff-enrichment>",
    );

    const degraded = harness({ outcome: "done" });
    degraded.deps.lookups.handoffEnrichment = async () => {
      throw new Error("git log unavailable");
    };
    await expect(processIssue(degraded.deps, degraded.input)).resolves.toMatchObject({ outcome: "done" });
    expect(degraded.trace.runAgentCalls[0]?.handoffContent ?? "").not.toContain("<handoff-enrichment>");
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


describe("processIssue — a DEACTIVATED review stage is a no-op (#2985)", () => {
  it("carries a post-DONE correction round straight to landing with no review await", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      // Round 1's gate fails, the Re-seed round's gate passes — the exact shape
      // that parked worker wAX3A in `validating` forever.
      feedbackResults: [false, true],
      reseedGateBudget: 1,
      locked: false,
      worktreeDiff: "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts\n+const x = 1;\n",
      adversarialReview: { enabled: false, maxIterations: 2, reviewerCount: 1, quorum: "any" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    // Nothing about the deactivated stage ran: no diff read, no reviewer
    // spawned, no verdict published — and, above all, nothing awaited.
    expect(trace.worktreeDiffCalls).toEqual([]);
    expect(trace.adversarialReviewContexts).toEqual([]);
    expect(trace.adversarialReviews).toEqual([]);
    // The correction round really happened; this is not a green-first-pass.
    expect(trace.iterLogs.some((l) => l.includes("correction retry 1/"))).toBe(true);
  });

  it("spends the round the review would have reserved instead of parking on it", async () => {
    // The operator bought FOUR gate corrections, which is the whole `/afk`
    // ceiling. With review deactivated its reserved round is dead capacity: the
    // fourth correction used to be refused with `reservation` while the ceiling
    // still had room, parking a branch one green round short.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, false, false, false, true],
      reseedGateBudget: 4,
      locked: false,
      adversarialReview: { enabled: false, maxIterations: 1, reviewerCount: 1, quorum: "any" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(5);
    expect(trace.iterLogs.some((l) => l.includes("correction retry 4/4"))).toBe(true);
    expect(trace.adversarialReviewContexts).toEqual([]);
  });
});

describe("processIssue — review is the gate fold's third stage (#2730)", () => {
  it("default-off path lands without running the reviewer", async () => {
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

  it("hands the reviewer the WORKTREE diff against the merge base, never a PR diff", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      worktreeDiff: "diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts\n+const fromWorktree = true;\n",
      adversarialReview: { enabled: true, maxIterations: 2, reviewerCount: 1, quorum: "any" },
      adversarialFindings: { summary: "Clean.", findings: [] },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    // The stage read the branch against the merge base, and read it BEFORE any
    // PR existed — so `gh pr diff` was never called at all.
    expect(trace.worktreeDiffCalls).toEqual([{ branch: "afk/9-fix-the-thing", base: "red-trunk" }]);
    expect(trace.adversarialReviewContexts[0]).toMatchObject({ base: "red-trunk" });
    expect(trace.adversarialReviewContexts[0]?.diff).toContain("const fromWorktree = true;");
    expect(trace.mergeCalls.some((argv) => argv.includes("pr") && argv.includes("diff"))).toBe(false);
  });

  it("enabled path reviews diff plus Issue only, comments on the Issue, then still lands", async () => {
    const issueBody = [
      "## Agent brief",
      "Implement the tracer.",
      "",
      "## Acceptance criteria",
      "- [ ] Post review findings to the Issue.",
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
      maxIterations: 2,
    });
    expect(trace.adversarialReviewContexts[0]?.diff).toContain("diff --git");
    expect(trace.adversarialReviews).toHaveLength(1);
    const body = trace.adversarialReviews[0]?.body ?? "";
    expect(body).toContain("AFK adversarial review");
    expect(body).toContain("Decision: not-blocking (advisory)");
    expect(body).toContain("blocking: false");
    expect(body).toContain("Acceptance criteria conformance finding.");
    expect(trace.comments).toContainEqual({ issue: 9, body });
    // No PR exists yet, so no PR comment was posted.
    expect(trace.comments.some((comment) => comment.issue === 42)).toBe(false);
  });

  it("does not run while an earlier gate stage is blocking", async () => {
    // `feedback` is red and the budget is spent, so the attempt parks there. The
    // review stage is the fold's most expensive one: it must never pay to review
    // a branch the cheap stages already rejected.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: false,
      reseedGateBudget: 0,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialFindings: { summary: "Never asked.", findings: [] },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.adversarialReviewContexts).toEqual([]);
    expect(trace.worktreeDiffCalls).toEqual([]);
    expect(trace.closed).toEqual([]);
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
    expect(retryHandoff).toContain("<worktree-diff data-untrusted=\"true\">");
    expect(retryHandoff).toContain("diff --git");

    expect(trace.adversarialReviews[0]?.body).toContain("Decision: blocking");
    expect(trace.adversarialReviews[1]?.body).toContain("Decision: not-blocking (advisory)");
    expect(trace.iterLogs.some((line) => line.includes("correction retry 1/1"))).toBe(true);
    // The round drew the RESERVED review cause, not the gate's share.
    expect(trace.workerEvents).toContainEqual({
      kind: "worker.reseeded",
      payload: {
        trigger: "review-finding",
        cause: "review",
        lane: "/afk",
        free: false,
        round: 1,
        ceiling: 4,
        cause_spent: 1,
        cause_cap: 1,
      },
    });
  });

  it("a gate round after a blocking review carries BOTH in one outstanding section (#2728)", async () => {
    // Round 1 lands on a blocking review; round 2's gate reddens while those
    // findings are still unfixed. The round-2 prompt must carry the review
    // findings AND the gate tail: the appenders this replaced each rebuilt from
    // the ORIGINAL handoff, so the gate round silently dropped the review block
    // and left the implementer blind to what round 1 had already confirmed.
    const { deps, input, trace } = harness({
      outcomes: ["done", "done", "done"],
      feedbackResults: [true, false, false],
      reseedGateBudget: 2,
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
          ],
        },
      ],
    });

    await processIssue(deps, input);

    const reviewHandoff = trace.runAgentCalls[1]?.handoffContent ?? "";
    expect(reviewHandoff).toContain("<adversarial-review-correction>");
    expect(reviewHandoff).toContain("The implementation does not satisfy the acceptance criterion.");

    const gateHandoff = trace.runAgentCalls[2]?.handoffContent ?? "";
    expect(gateHandoff).toContain("<afk-gate-correction>");
    const section = gateHandoff.slice(
      gateHandoff.indexOf("<outstanding-state>"),
      gateHandoff.indexOf("</outstanding-state>"),
    );
    expect(section).toContain("The implementation does not satisfy the acceptance criterion.");
    expect(section).toContain("<validation-tail>");
    expect(gateHandoff.match(/<outstanding-state>/g)).toHaveLength(1);
    expect(gateHandoff).toContain("<reseed-history>");
    expect(gateHandoff).toContain("Re-seed round 2/4");
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
    expect(trace.adversarialReviews[0]?.body).toContain("Decision: not-blocking (advisory)");
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
    expect(trace.adversarialReviews[0]?.body).toContain("Decision: not-blocking (advisory)");
    expect(trace.adversarialReviews[0]?.body).toContain("blocking: false");
    expect(trace.closed).toEqual([9]);
  });

  it("the DOCUMENTED DEFAULT review budget parks an unresolved blocking finding instead of landing it", async () => {
    // The revoked behaviour (#2730): at the default budget the decision function
    // read its own cap, and a cap below 2 turned an unresolved BLOCKING finding
    // into "pass" — the Ticket landed carrying a defect the reviewer had named
    // twice. The verdict is cap-free now, so exhaustion parks like every other
    // Re-seed cause.
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
      outcomes: ["done", "done"],
      feedbackOk: true,
      locked: false,
      // `dev.review.max_iterations` at its documented default of 1.
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialFindingsSequence: [blocking, blocking],
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    // One reserved review round was drawn; the second blocking review found the
    // sub-cap spent and parked.
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.adversarialReviewContexts).toHaveLength(2);
    expect(trace.closed).toEqual([]);
    expect(labelTrace(trace)).toContain("-running|+ready-for-human+blocked:validation");
    expect(trace.adversarialReviews[0]?.body).toContain("Decision: blocking");
    expect(trace.adversarialReviews[1]?.body).toContain("Decision: blocking");

    const blocker = parseCurrentBlocker(trace.bodyEdits.at(-1)?.body ?? "");
    expect(blocker).toMatchObject({
      status: "blocked",
      kind: "validation",
      summary: expect.stringContaining("packages/x/src/a.ts:1"),
      next: expect.stringContaining("Decide whether to fix forward"),
    });
    expect(blocker?.summary).toContain("The implementation still omits the required audit trail.");
    expect(trace.envelopeBodies.at(-1)).toContain("Re-seed budget exhausted for the review stage");
  });

  it("three gate Re-seeds do not starve the review's reserved round", async () => {
    // The starvation defect (#2730): under one flat counter, gate churn spent
    // every available round and the review's own round never fired — a blocking
    // finding raised on a branch that had already corrected three times simply
    // landed. The review round is a RESERVATION, so it is still there.
    const { deps, input, trace } = harness({
      outcomes: ["done", "done", "done", "done", "done"],
      // Three red gate rounds, then a green one the review gets to see.
      feedbackResults: [false, false, false, true, true],
      reseedGateBudget: 3,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialFindingsSequence: [
        {
          summary: "Blocking finding after three gate corrections.",
          findings: [
            {
              path: "packages/x/src/a.ts",
              line: 1,
              body: "The audit trail is still missing.",
              blocking: true,
            },
          ],
        },
        { summary: "Clean after the review correction.", findings: [] },
      ],
    });
    const result = await processIssue(deps, input);

    // Three gate rounds spent the gate's sub-cap; the review still fired and got
    // its own round, and the corrected branch landed.
    expect(trace.runAgentCalls).toHaveLength(5);
    expect(trace.adversarialReviewContexts).toHaveLength(2);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls[4]?.handoffContent ?? "").toContain("<adversarial-review-correction>");
    const causes = trace.workerEvents
      .filter((event) => event.kind === "worker.reseeded")
      .map((event) => (event.payload as { cause: string } | undefined)?.cause);
    expect(causes).toEqual(["gate", "gate", "gate", "review"]);
  });

  it("a reviewer that throws yields a SKIPPED stage and the attempt proceeds (#2352)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialExtractError: "claude-code exited with code 1",
    });
    const result = await processIssue(deps, input);

    // The stage ran and blew up — a skipped stage never blocks, so the
    // machine-validated attempt still lands.
    expect(trace.adversarialReviewContexts).toHaveLength(1);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    // No verdict was posted, and the implementer was NOT re-seeded.
    expect(trace.adversarialReviews).toEqual([]);
    expect(trace.runAgentCalls).toHaveLength(1);
    // The failure is logged AND recorded in the attempt ledger.
    expect(
      trace.iterLogs.some((line) =>
        line.includes("[adversarial-review] review stage skipped: claude-code exited with code 1"),
      ),
    ).toBe(true);
    expect(trace.workerEvents).toContainEqual({
      kind: "worker.review_degraded",
      payload: { issue: 9, decision: "skipped", reason: "claude-code exited with code 1" },
    });
  });

  it("substitutes a reviewer model the host runner cannot dispatch and logs it (#2352)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      classifyIssue: async () => "complex",
      resolveTier: () => ({ model: "claude-opus-4-8", effort: "medium" }),
      // The repo pins a codex model, but the host runner is claude (the #2352 outage).
      adversarialReview: {
        enabled: true,
        maxIterations: 1,
        reviewerCount: 1,
        quorum: "any",
        model: "gpt-5.6-sol",
        effort: "medium",
      },
      adversarialFindings: { summary: "Clean.", findings: [] },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.adversarialReviewContexts).toHaveLength(1);
    expect(trace.adversarialReviewContexts[0]).toMatchObject({
      runner: "claude",
      model: "claude-opus-4-8",
      effort: "medium",
    });
    expect(
      trace.iterLogs.some(
        (line) =>
          line.includes("cannot run model 'gpt-5.6-sol'") && line.includes("claude-opus-4-8"),
      ),
    ).toBe(true);
    expect(trace.closed).toEqual([9]);
  });
});


describe("processIssue — uncommitted work is disposable (ADR 0103)", () => {
  it("DONE with commits + dirty leftovers → validates the COMMITTED work only, no salvage commit", async () => {
    // The codex DONE-without-commit class is no longer rescued at exit. The run
    // proceeds on whatever the agent committed (already on origin via the
    // continuous-push hook); the dirty remainder is dropped without a word about
    // salvaging it.
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
      locked: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
    expect(trace.iterLogs.some((line) => line.includes("uncommitted file(s)"))).toBe(false);
    expect(trace.iterLogs.some((line) => line.includes("exit barrier"))).toBe(false);
  });

  it("DONE + feedback fail reports the plain validation failure — no salvage narrative", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [{ sha: "deadbee" }],
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    const body = trace.envelopeBodies.at(-1) ?? "";
    expect(body).toContain("Feedback validation failed after the inner agent emitted DONE");
    expect(body).not.toContain("AFK salvaged");
  });

  it("no-sentinel + zero commits stays the empty-branch terminal — nothing is rescued", async () => {
    const { deps, input, trace } = harness({
      outcome: "no-sentinel",
      commits: [],
      changedFiles: [],
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    expect(trace.iterLogs.some((line) => line.includes("uncommitted file(s)"))).toBe(false);
  });

  it("DONE with zero commits but a branch carrying work still lands (continuous push, unchanged)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      commits: [],
      changedFiles: ["packages/x/src/a.ts"],
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
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

describe("processIssue — daemon-granted fork point (ADR 0138)", () => {
  it("forks exactly the granted commit without fetching the trunk", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });

    await processIssue(deps, input);

    expect(trace.freshWorkerBranchCalls[0]?.baseRef).toBe("granted-fork-sha");
    expect(trace.iterLogs.some((line) => line.includes("version skew"))).toBe(false);
  });
});

describe("processIssue — pre_merge hook abort (primary checkout untouched, #2628)", () => {
  it("pre_merge abort: push happened but no integration ran, routes to merge-conflict", async () => {
    // Pins AC1/AC2 from #2628: pre_merge fires after the attempt push but before
    // any integration command. An abort must leave the primary checkout untouched —
    // Landing runs entirely inside its isolated worktree; no primary snapshot commit
    // is created. The lifecycle routes the abort to merge-conflict, not a hard error.
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, abortHook: "pre_merge" });
    const result = await processIssue(deps, input);

    // pre_merge-abort feeds mergeFailed → merge-conflict outcome.
    expect(result.outcome).toBe("merge-conflict");
    // The attempt was pushed (push precedes the hook) — the remote ref exists.
    expect(trace.pushedAttempt).toHaveLength(1);
    // No merge or integration command ran after the abort. The park does run
    // the #2811 tracker-visibility probe (`rev-list --count` on the pushed
    // branch, then the idempotent PR open) — committed work that reached origin
    // is never parked out of sight — but nothing integrates or merges.
    const mergeJoined = trace.mergeCalls.map((c) => c.join(" "));
    expect(mergeJoined.some((c) => /\bgit .*\bmerge\b|\bpr merge\b/.test(c))).toBe(false);
    expect(mergeJoined.some((c) => c.includes("rev-list --count"))).toBe(true);
    expect(mergeJoined.some((c) => c.includes("pr create"))).toBe(true);
    // pre_merge fired; post_merge did not — no integration ran.
    expect(result.hooksFired).toContain("pre_merge");
    expect(result.hooksFired).not.toContain("post_merge");
  });
});

describe("processIssue — land-lock timeout self-requeue (#2596)", () => {
  it("land-lock wait timeout → self-requeue to ready-for-agent, not ready-for-human + blocked:infra", async () => {
    // Regression: a sibling worker held the land-lock past the wait timeout. The
    // second worker MUST back off to ready-for-agent (self-requeue), not park the
    // issue to ready-for-human + blocked:infra. The timeout is a serialization
    // backoff, not an infra failure — no human decision is needed to recover.
    const timedOutLock = { acquire: async () => null };
    const { deps, input, trace } = harness({ landLock: timedOutLock });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("infra");
    // Must NOT park to ready-for-human.
    const allAdded = trace.labelEdits.flatMap((e) => e.add);
    expect(allAdded).not.toContain("ready-for-human");
    // Must NOT add a blocked:infra label.
    expect(allAdded).not.toContain("blocked:infra");
    expect(trace.ensuredLabels).not.toContain("blocked:infra");
    // Must requeue: the last label edit adds ready-for-agent.
    const lastEdit = trace.labelEdits.at(-1);
    expect(lastEdit?.add).toContain("ready-for-agent");
    // Comment must name the branch so the next attempt can adopt it.
    const requeueComment = trace.comments.find(
      (c) => c.body.includes("land-lock") && c.body.includes("ready-for-agent"),
    );
    expect(requeueComment).toBeDefined();
    expect(requeueComment?.body).toContain(result.branch ?? "afk/");
    // No failure envelope was posted — this is a clean backoff, not a failure.
    expect(trace.postedEnvelopes).toEqual([]);
  });
});

describe("processIssue — the Re-seed trail's two derived surfaces (#2731)", () => {
  const prCreates = (trace: { mergeCalls: string[][] }): string[][] =>
    trace.mergeCalls.filter((argv) => argv.includes("pr") && argv.includes("create"));

  it("opens NO pull request before landing when the attempt never re-seeds", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    // Exactly one create, and it is the landing's own — no draft, no trail.
    expect(prCreates(trace)).toHaveLength(1);
    expect(prCreates(trace)[0]).not.toContain("--draft");
    expect(trace.trailComments).toEqual([]);
    expect(trace.trailCommentEdits).toEqual([]);
  });

  it("mints exactly one DRAFT pull request on the first Re-seed", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      // One red gate, then green: one Re-seed, then landing.
      feedbackResults: [false, true],
      reseedGateBudget: 2,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    const creates = prCreates(trace);
    expect(creates).toHaveLength(1);
    expect(creates[0]).toContain("--draft");
    // The draft body mirrors the trail and keeps the auto-close link.
    const body = creates[0]![creates[0]!.indexOf("--body") + 1] ?? "";
    expect(body).toContain("Re-seed trail");
    expect(body).toContain("Closes #9");
  });

  it("lands by reusing that draft and marking it ready, never opening a second", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, true],
      reseedGateBudget: 2,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(prCreates(trace)).toHaveLength(1);
    const joined = trace.mergeCalls.map((argv) => argv.join(" "));
    expect(joined.some((c) => c.includes("pr ready 42"))).toBe(true);
    expect(joined.some((c) => c.includes("pr merge 42 --merge"))).toBe(true);
  });

  it("edits ONE Issue comment across repeated rounds instead of appending new ones", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      // Two red gates, then green: two Re-seed rounds on one comment.
      feedbackResults: [false, false, true],
      reseedGateBudget: 3,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(3);
    expect(trace.trailComments).toHaveLength(1);
    expect(trace.trailCommentEdits).toHaveLength(1);
    expect(trace.trailCommentEdits[0]?.commentId).toBe(trace.trailComments[0]?.id);
    // The edit carries BOTH rounds; the original post carried only the first.
    expect(trace.trailComments[0]?.body).toContain("1/4");
    expect(trace.trailComments[0]?.body).not.toContain("2/4");
    expect(trace.trailCommentEdits[0]?.body).toContain("2/4");
    // Still one pull request, still a draft.
    expect(prCreates(trace)).toHaveLength(1);
  });
});

describe("processIssue — an exhausted Re-seed budget parks with the draft open (#2732)", () => {
  const prCalls = (trace: { mergeCalls: string[][] }, verb: string): string[][] =>
    trace.mergeCalls.filter((argv) => argv.includes("pr") && argv.includes(verb));
  /** Every `gh pr edit --add-label` applied to the draft. */
  const prLabels = (trace: { mergeCalls: string[][] }): string[] =>
    prCalls(trace, "edit")
      .filter((argv) => argv.includes("--add-label"))
      .map((argv) => argv[argv.indexOf("--add-label") + 1] ?? "");
  /** The LAST body written onto the draft — the park's own. */
  const lastPrBody = (trace: { mergeCalls: string[][] }): string => {
    const bodies = trace.mergeCalls
      .filter((argv) => argv.includes("--body"))
      .map((argv) => argv[argv.indexOf("--body") + 1] ?? "");
    return bodies.at(-1) ?? "";
  };
  /** The LAST body written onto the trail's Issue comment. */
  const lastIssueBody = (trace: {
    trailComments: Array<{ body: string }>;
    trailCommentEdits: Array<{ body: string }>;
  }): string => trace.trailCommentEdits.at(-1)?.body ?? trace.trailComments.at(-1)?.body ?? "";

  /** A budget exhausted by GATE churn: one correction round, then the same red
   * gate again with nothing left to draw. */
  const gateExhaustion = () =>
    harness({
      outcome: "done",
      feedbackResults: [false, false],
      reseedGateBudget: 1,
    });

  /** A budget exhausted by the RESERVED review round: a blocking finding draws
   * it, and the finding survives the correction. */
  const reviewExhaustion = () => {
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
    return harness({
      outcomes: ["done", "done"],
      feedbackOk: true,
      locked: false,
      adversarialReview: { enabled: true, maxIterations: 1, reviewerCount: 1, quorum: "any" },
      adversarialFindingsSequence: [blocking, blocking],
    });
  };

  it("leaves the draft pull request OPEN — a validation park is when the diff is needed", async () => {
    const { deps, input, trace } = gateExhaustion();
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    // The draft was minted by the first Re-seed and never closed on the way out.
    expect(prCalls(trace, "create")).toHaveLength(1);
    expect(prCalls(trace, "close")).toEqual([]);
    expect(prCalls(trace, "merge")).toEqual([]);
  });

  it("marks the parked draft with the same blocked-validation label the Ticket carries", async () => {
    const { deps, input, trace } = gateExhaustion();
    await processIssue(deps, input);

    expect(prLabels(trace)).toContain("blocked:validation");
    // The Ticket parks with the very same label — one query answers for both.
    expect(
      trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:validation")),
    ).toBe(true);
    expect(lastPrBody(trace)).toContain(reseedParkMarker(9));
  });

  it("puts the accumulated evidence on BOTH the Issue and the pull request at park time", async () => {
    const { deps, input, trace } = gateExhaustion();
    await processIssue(deps, input);

    for (const body of [lastIssueBody(trace), lastPrBody(trace)]) {
      expect(body).toContain(reseedParkMarker(9));
      // The rounds already spent…
      expect(body).toContain("Re-seed trail");
      expect(body).toContain("machine gate failed after DONE");
      // …and the evidence that ended the budget.
      expect(body).toContain("Evidence at park time");
      expect(body).toContain('"status":"failed"');
    }
    // Still ONE comment: the park edits the trail rather than notifying again.
    expect(trace.trailComments).toHaveLength(1);
  });

  it("parks identically whatever cause exhausted the budget", async () => {
    const gate = gateExhaustion();
    const review = reviewExhaustion();
    const gateResult = await processIssue(gate.deps, gate.input);
    const reviewResult = await processIssue(review.deps, review.input);

    expect(gateResult.outcome).toBe("feedback-failed");
    expect(reviewResult.outcome).toBe("feedback-failed");
    for (const trace of [gate.trace, review.trace]) {
      expect(prCalls(trace, "create")).toHaveLength(1);
      expect(prCalls(trace, "close")).toEqual([]);
      expect(prLabels(trace)).toContain("blocked:validation");
      expect(lastPrBody(trace)).toContain(reseedParkMarker(9));
      expect(lastIssueBody(trace)).toContain(reseedParkMarker(9));
      expect(lastPrBody(trace)).toContain("Evidence at park time");
      expect(lastIssueBody(trace)).toContain("Evidence at park time");
    }
    // The evidence itself is the one thing that differs: each cause carries what
    // IT left red.
    expect(lastIssueBody(review.trace)).toContain("The implementation still omits the required audit trail.");
  });

  it("parks with no draft to seal when the attempt never re-seeded", async () => {
    // Budget 0: the first red gate has nothing to draw, so no round is ever
    // published and no pull request is minted. The park is the Ticket's alone.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false],
      reseedGateBudget: 0,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(prCalls(trace, "create")).toEqual([]);
    expect(prLabels(trace)).toEqual([]);
    expect(trace.trailComments).toEqual([]);
  });
});
