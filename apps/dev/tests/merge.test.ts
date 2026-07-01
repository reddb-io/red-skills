import { describe, expect, it } from "vitest";
import {
  integrateOrigin,
  landMerge,
  landPr,
  openReviewPr,
  preMergeRebase,
  resolveMergeConflict,
  buildConflictPrompt,
  waitForReviewCheck,
  classifyMergeState,
  parseMergeStateView,
  waitForMergeReady,
  type Exec,
  type ExecResult,
} from "../src/core/merge.js";

/**
 * Build a fake Exec that records every argv it sees and replies from a
 * per-call queue keyed on the first token (`git`/`gh`) plus a matcher over the
 * joined argv. The default reply is success with empty output, so a test only
 * needs to override the calls whose stdout/exit code drive a decision.
 */
function fakeExec(
  rules: Array<{ match: (argv: string[]) => boolean; result: Partial<ExecResult> }> = [],
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    for (const rule of rules) {
      if (rule.match(argv)) {
        return { code: 0, stdout: "", stderr: "", ...rule.result };
      }
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const joined = (calls: string[][]): string[] => calls.map((c) => c.join(" "));

describe("integrateOrigin", () => {
  it("no-ops when local already at the origin tip", async () => {
    const { exec, calls } = fakeExec();
    const result = await integrateOrigin(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "main",
      stillBehind: false,
      inSync: true,
    });
    expect(result.action).toBe("in-sync");
    expect(result.ok).toBe(true);
    // No merge/rebase argv issued.
    expect(joined(calls).some((c) => c.includes("merge") || c.includes("rebase"))).toBe(false);
  });

  it("fast-forwards when local is strictly behind origin", async () => {
    const { exec, calls } = fakeExec();
    const result = await integrateOrigin(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "main",
      stillBehind: true,
      inSync: false,
    });
    expect(result.action).toBe("fast-forward");
    expect(result.ok).toBe(true);
    expect(joined(calls)).toContain("git -C /repo merge --ff-only origin/main");
    expect(joined(calls).some((c) => c.includes("rebase"))).toBe(false);
  });

  it("rebases local commits onto the moved tip when diverged", async () => {
    const { exec, calls } = fakeExec();
    const result = await integrateOrigin(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "main",
      stillBehind: false,
      inSync: false,
    });
    expect(result.action).toBe("rebase");
    expect(result.ok).toBe(true);
    expect(joined(calls)).toContain("git -C /repo rebase origin/main");
    expect(joined(calls).some((c) => c.includes("--ff-only"))).toBe(false);
  });

  it("aborts the rebase and fails when the replay conflicts", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("rebase") && !a.includes("--abort"), result: { code: 1 } },
    ]);
    const result = await integrateOrigin(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "main",
      stillBehind: false,
      inSync: false,
    });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("rebase");
    expect(joined(calls)).toContain("git -C /repo rebase origin/main");
    expect(joined(calls)).toContain("git -C /repo rebase --abort");
  });

  it("fails when the fast-forward merge itself fails", async () => {
    const { exec } = fakeExec([
      { match: (a) => a.includes("--ff-only"), result: { code: 1 } },
    ]);
    const result = await integrateOrigin(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "main",
      stillBehind: true,
      inSync: false,
    });
    expect(result.ok).toBe(false);
    expect(result.action).toBe("fast-forward");
  });
});

describe("landMerge (locked path)", () => {
  it("merges --no-ff into the locked branch then pushes it", async () => {
    const { exec, calls } = fakeExec();
    const result = await landMerge(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "afk/wAAAA/9-x",
      target: "work-branch",
      n: 9,
      title: "do thing",
      preMergeSha: "deadbeef",
    });
    expect(result.ok).toBe(true);
    expect(result.rolledBack).toBe(false);
    // `--no-verify` bypasses the consumer repo's commit-phase hooks on the merge (#840).
    expect(joined(calls)).toContain('git -C /repo merge --no-ff --no-verify afk/wAAAA/9-x -m merge: #9 do thing');
    // Pushes the detached worktree HEAD to the target ref (#572), not a bare branch.
    expect(joined(calls)).toContain("git -C /repo push origin HEAD:refs/heads/work-branch");
    // No rollback on the happy path.
    expect(joined(calls).some((c) => c.includes("reset --hard"))).toBe(false);
  });

  it("rolls back to pre_merge_sha when the push is rejected", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("push"), result: { code: 1 } },
    ]);
    const result = await landMerge(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "afk/wAAAA/9-x",
      target: "work-branch",
      n: 9,
      title: "do thing",
      preMergeSha: "deadbeef",
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(joined(calls)).toContain("git -C /repo reset --hard deadbeef");
  });

  it("fails without pushing when the merge itself fails", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("merge") && a.includes("--no-ff"), result: { code: 1 } },
    ]);
    const result = await landMerge(exec, {
      repo: "/repo",
      remote: "origin",
      branch: "afk/wAAAA/9-x",
      target: "work-branch",
      n: 9,
      title: "do thing",
      preMergeSha: "deadbeef",
    });
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(joined(calls).some((c) => c.includes("push"))).toBe(false);
  });
});

describe("landPr (unlocked path)", () => {
  it("force-pushes the attempt, creates a PR, admin-merges it, then ffs local", async () => {
    // pr list returns empty before create, then 77 after.
    let prMade = false;
    const exec: Exec = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd.includes("pr create")) prMade = true;
      if (cmd.includes("pr list")) {
        return { code: 0, stdout: prMade ? "77\n" : "\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const calls: string[][] = [];
    const recording: Exec = async (argv) => {
      calls.push(argv);
      return exec(argv);
    };
    const result = await landPr(recording, {
      repo: "reddb-io/red-skills",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/wBBBB/9-x",
      target: "main",
      n: 9,
      title: "do thing",
      worktree: "/repo/wt",
    });
    expect(result.ok).toBe(true);
    const c = joined(calls);
    expect(c).toContain(
      "git -C /repo/wt push origin HEAD:refs/heads/afk/wBBBB/9-x --force-with-lease",
    );
    expect(
      c.some((x) => x.includes("pr create --base main --head afk/wBBBB/9-x")),
    ).toBe(true);
    expect(c.some((x) => x.includes("pr merge 77 --admin --merge"))).toBe(true);
    // Local ff-merge to carry the merge commit for the closing envelope.
    expect(c).toContain("git -C /repo merge --ff-only origin/main");
    // No direct merge of the attempt branch into target.
    expect(c.some((x) => x.includes("merge --no-ff afk/wBBBB/9-x"))).toBe(false);
  });

  it("reuses an already-open PR instead of creating a second one", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "42\n" } },
    ]);
    const result = await landPr(exec, {
      repo: "reddb-io/red-skills",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/wCCCC/9-x",
      target: "main",
      n: 9,
      title: "t",
    });
    expect(result.ok).toBe(true);
    const c = joined(calls);
    expect(c.some((x) => x.includes("pr create"))).toBe(false);
    expect(c.some((x) => x.includes("pr merge 42 --admin --merge"))).toBe(true);
  });

  it("returns failure when the admin-merge fails", async () => {
    const { exec } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "5\n" } },
      { match: (a) => a.join(" ").includes("pr merge"), result: { code: 1 } },
    ]);
    const result = await landPr(exec, {
      repo: "reddb-io/red-skills",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/wDDDD/9-x",
      target: "main",
      n: 9,
      title: "t",
    });
    expect(result.ok).toBe(false);
  });

  it("fails when no PR can be resolved after create", async () => {
    const { exec } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "\n" } },
    ]);
    const result = await landPr(exec, {
      repo: "reddb-io/red-skills",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/wEEEE/9-x",
      target: "main",
      n: 9,
      title: "t",
    });
    expect(result.ok).toBe(false);
  });
});

describe("openReviewPr (review-gate handoff, #749)", () => {
  it("creates the PR, applies ready-for-review, and never admin-merges", async () => {
    // pr list is empty before create, then 88 after (the default-rule fake
    // can't express "empty then 88"), so build a bespoke recording exec.
    let prMade = false;
    const recorded: string[][] = [];
    const review: Exec = async (argv) => {
      recorded.push(argv);
      const cmd = argv.join(" ");
      if (cmd.includes("pr create")) prMade = true;
      if (cmd.includes("pr list")) return { code: 0, stdout: prMade ? "88\n" : "\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await openReviewPr(review, {
      repo: "reddb-io/red-skills",
      branch: "afk/wBBBB/9-x",
      target: "main",
      n: 9,
      title: "risky change",
      reviewLabel: "ready-for-review",
    });
    expect(result).toEqual({ ok: true, prNumber: 88 });
    const c = joined(recorded);
    expect(c.some((x) => x.includes("pr create --base main --head afk/wBBBB/9-x"))).toBe(true);
    expect(c).toContain("gh -R reddb-io/red-skills pr edit 88 --add-label ready-for-review");
    // The whole point: the merge is held for the fresh-agent review.
    expect(c.some((x) => x.includes("pr merge"))).toBe(false);
  });

  it("reuses an open PR and re-applies the label (idempotent)", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "42\n" } },
    ]);
    const result = await openReviewPr(exec, {
      repo: "reddb-io/red-skills",
      branch: "afk/wCCCC/9-x",
      target: "main",
      n: 9,
      title: "t",
      reviewLabel: "ready-for-review",
    });
    expect(result).toEqual({ ok: true, prNumber: 42 });
    const c = joined(calls);
    expect(c.some((x) => x.includes("pr create"))).toBe(false);
    expect(c).toContain("gh -R reddb-io/red-skills pr edit 42 --add-label ready-for-review");
  });

  it("fails when the label edit fails (PR still resolved)", async () => {
    const { exec } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "5\n" } },
      { match: (a) => a.join(" ").includes("pr edit"), result: { code: 1 } },
    ]);
    const result = await openReviewPr(exec, {
      repo: "reddb-io/red-skills",
      branch: "afk/wDDDD/9-x",
      target: "main",
      n: 9,
      title: "t",
      reviewLabel: "ready-for-review",
    });
    expect(result).toEqual({ ok: false, prNumber: 5 });
  });

  it("fails when no PR can be resolved", async () => {
    const { exec } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "\n" } },
    ]);
    const result = await openReviewPr(exec, {
      repo: "reddb-io/red-skills",
      branch: "afk/wEEEE/9-x",
      target: "main",
      n: 9,
      title: "t",
      reviewLabel: "ready-for-review",
    });
    expect(result.ok).toBe(false);
  });
});

describe("waitForReviewCheck (afk.merge.wait_for_review)", () => {
  // gh pr checks --json name,state stdout per attempt, replayed in order.
  function pollExec(stdouts: string[]): { exec: Exec; calls: string[][] } {
    const calls: string[][] = [];
    let i = 0;
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const out = stdouts[Math.min(i, stdouts.length - 1)] ?? "[]";
      i++;
      return { code: 0, stdout: out, stderr: "" };
    };
    return { exec, calls };
  }
  const noSleep = async () => {};

  it("returns once the named check reaches a terminal state, no further polls", async () => {
    const { exec, calls } = pollExec([
      JSON.stringify([{ name: "CodeRabbit", state: "PENDING" }]),
      JSON.stringify([{ name: "CodeRabbit", state: "SUCCESS" }]),
    ]);
    const r = await waitForReviewCheck(exec, "o/r", 77, { check: "CodeRabbit", sleep: noSleep });
    expect(r).toBe("concluded");
    // two polls: pending then success; no third poll after conclusion.
    expect(calls.filter((c) => c.join(" ").includes("pr checks 77")).length).toBe(2);
  });

  it("concludes on a FAILURE state too — the wait never gates on the verdict", async () => {
    const { exec } = pollExec([JSON.stringify([{ name: "CodeRabbit", state: "FAILURE" }])]);
    const r = await waitForReviewCheck(exec, "o/r", 77, { check: "coderabbit", sleep: noSleep });
    expect(r).toBe("concluded");
  });

  it("matches the check name case-insensitively as a substring", async () => {
    const { exec } = pollExec([
      JSON.stringify([{ name: "CodeRabbit / review", state: "SUCCESS" }]),
    ]);
    const r = await waitForReviewCheck(exec, "o/r", 1, { check: "coderabbit", sleep: noSleep });
    expect(r).toBe("concluded");
  });

  it("times out (fail-open) when the check stays pending past maxPolls", async () => {
    let sleeps = 0;
    const { exec, calls } = pollExec([JSON.stringify([{ name: "CodeRabbit", state: "PENDING" }])]);
    const r = await waitForReviewCheck(exec, "o/r", 9, {
      check: "CodeRabbit",
      sleep: async () => { sleeps++; },
      maxPolls: 3,
    });
    expect(r).toBe("timeout");
    expect(calls.filter((c) => c.join(" ").includes("pr checks")).length).toBe(3);
    // sleeps between polls only (one fewer than polls).
    expect(sleeps).toBe(2);
  });

  it("reports absent when the check never registers", async () => {
    const { exec } = pollExec([JSON.stringify([{ name: "other-ci", state: "PENDING" }])]);
    const r = await waitForReviewCheck(exec, "o/r", 9, { check: "CodeRabbit", sleep: noSleep, maxPolls: 2 });
    expect(r).toBe("absent");
  });

  it("tolerates non-JSON / empty stdout and keeps polling", async () => {
    const { exec } = pollExec(["", "not json", JSON.stringify([{ name: "CodeRabbit", state: "SUCCESS" }])]);
    const r = await waitForReviewCheck(exec, "o/r", 9, { check: "CodeRabbit", sleep: noSleep });
    expect(r).toBe("concluded");
  });
});

describe("landPr wait_for_review wiring", () => {
  it("polls the review check before admin-merge when waitForReview is set", async () => {
    let checksPolled = false;
    let mergedAfterPoll = false;
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const cmd = argv.join(" ");
      if (cmd.includes("pr list")) return { code: 0, stdout: "77\n", stderr: "" };
      if (cmd.includes("pr checks")) {
        checksPolled = true;
        return { code: 0, stdout: JSON.stringify([{ name: "CodeRabbit", state: "SUCCESS" }]), stderr: "" };
      }
      if (cmd.includes("pr merge")) {
        mergedAfterPoll = checksPolled; // merge must come AFTER the poll
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = await landPr(exec, {
      repo: "o/r",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/wX/9-x",
      target: "main",
      n: 9,
      title: "t",
      waitForReview: { check: "CodeRabbit", sleep: async () => {} },
    });
    expect(result.ok).toBe(true);
    expect(checksPolled).toBe(true);
    expect(mergedAfterPoll).toBe(true);
    expect(calls.some((c) => c.join(" ").includes("pr merge 77 --admin --merge"))).toBe(true);
  });

  it("does NOT poll review checks by default (waitForReview absent)", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "42\n" } },
    ]);
    const result = await landPr(exec, {
      repo: "o/r",
      gitRepo: "/repo",
      remote: "origin",
      branch: "afk/wX/9-x",
      target: "main",
      n: 9,
      title: "t",
    });
    expect(result.ok).toBe(true);
    expect(joined(calls).some((c) => c.includes("pr checks"))).toBe(false);
    expect(joined(calls).some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
  });
});

describe("CI-aware merge classification (#812)", () => {
  const view = (mergeStateStatus: string, rollup: unknown[] = []) =>
    parseMergeStateView(JSON.stringify({ mergeStateStatus, statusCheckRollup: rollup }));

  it("CLEAN → merge", () => {
    expect(classifyMergeState(view("CLEAN"))).toBe("merge");
  });

  it("DIRTY (real git conflict) → conflict", () => {
    expect(classifyMergeState(view("DIRTY"))).toBe("conflict");
  });

  it("BEHIND (non-fast-forward) → conflict", () => {
    expect(classifyMergeState(view("BEHIND"))).toBe("conflict");
  });

  it("BLOCKED with a FAILED required check → ci-failed", () => {
    const v = view("BLOCKED", [
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
    ]);
    expect(classifyMergeState(v)).toBe("ci-failed");
  });

  it("a failed legacy StatusContext (state=FAILURE) → ci-failed", () => {
    expect(classifyMergeState(view("BLOCKED", [{ state: "FAILURE" }]))).toBe("ci-failed");
  });

  it("BLOCKED with checks still running → pending", () => {
    const v = view("BLOCKED", [{ __typename: "CheckRun", status: "IN_PROGRESS" }]);
    expect(classifyMergeState(v)).toBe("pending");
  });

  it("a COMPLETED CheckRun without a conclusion yet → pending", () => {
    expect(classifyMergeState(view("BLOCKED", [{ status: "COMPLETED", conclusion: "" }]))).toBe("pending");
  });

  it("BLOCKED by required REVIEW only (all checks green) → merge (admin waives review)", () => {
    const v = view("BLOCKED", [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }]);
    expect(classifyMergeState(v)).toBe("merge");
  });

  it("UNSTABLE (only non-required checks unsettled) → merge", () => {
    expect(classifyMergeState(view("UNSTABLE"))).toBe("merge");
  });

  it("UNKNOWN / empty (GitHub still computing) → pending", () => {
    expect(classifyMergeState(view("UNKNOWN"))).toBe("pending");
    expect(classifyMergeState(view(""))).toBe("pending");
  });

  it("a failed check outweighs DIRTY only after the conflict check — DIRTY wins first", () => {
    // DIRTY is a git-level problem; classify it as conflict even if a check also failed.
    expect(classifyMergeState(view("DIRTY", [{ state: "FAILURE" }]))).toBe("conflict");
  });

  it("parseMergeStateView tolerates non-JSON / empty stdout", () => {
    expect(parseMergeStateView("")).toEqual({ mergeStateStatus: "", anyFailed: false, anyPending: false });
    expect(parseMergeStateView("not json")).toEqual({ mergeStateStatus: "", anyFailed: false, anyPending: false });
  });
});

describe("waitForMergeReady (#812 poll loop)", () => {
  function pollExec(views: string[]): { exec: Exec; calls: string[][] } {
    const calls: string[][] = [];
    let i = 0;
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const out = views[Math.min(i, views.length - 1)] ?? "{}";
      i++;
      return { code: 0, stdout: out, stderr: "" };
    };
    return { exec, calls };
  }
  const noSleep = async () => {};
  const v = (mergeStateStatus: string, rollup: unknown[] = []) =>
    JSON.stringify({ mergeStateStatus, statusCheckRollup: rollup });

  it("polls until the PR goes CLEAN, then returns merge", async () => {
    const { exec, calls } = pollExec([v("UNKNOWN"), v("BLOCKED", [{ status: "IN_PROGRESS" }]), v("CLEAN")]);
    const r = await waitForMergeReady(exec, "o/r", 77, { sleep: noSleep });
    expect(r).toBe("merge");
    expect(calls.filter((c) => c.join(" ").includes("pr view 77")).length).toBe(3);
    expect(calls[0].join(" ")).toContain("--json mergeStateStatus,statusCheckRollup");
  });

  it("returns ci-failed immediately on a failed required check (no further polls)", async () => {
    const { exec, calls } = pollExec([v("BLOCKED", [{ state: "FAILURE" }])]);
    const r = await waitForMergeReady(exec, "o/r", 1, { sleep: noSleep });
    expect(r).toBe("ci-failed");
    expect(calls.length).toBe(1);
  });

  it("returns conflict on DIRTY", async () => {
    const { exec } = pollExec([v("DIRTY")]);
    expect(await waitForMergeReady(exec, "o/r", 1, { sleep: noSleep })).toBe("conflict");
  });

  it("times out to pending when checks never settle", async () => {
    let sleeps = 0;
    const { exec, calls } = pollExec([v("BLOCKED", [{ status: "QUEUED" }])]);
    const r = await waitForMergeReady(exec, "o/r", 9, { sleep: async () => { sleeps++; }, maxPolls: 3 });
    expect(r).toBe("pending");
    expect(calls.filter((c) => c.join(" ").includes("pr view")).length).toBe(3);
    expect(sleeps).toBe(2);
  });
});

describe("landPr CI-aware wiring (#812)", () => {
  it("polls merge state then admin-merges once CLEAN", async () => {
    let viewed = false;
    let mergedAfterView = false;
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const cmd = argv.join(" ");
      if (cmd.includes("pr list")) return { code: 0, stdout: "77\n", stderr: "" };
      if (cmd.includes("pr view")) {
        viewed = true;
        return { code: 0, stdout: JSON.stringify({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }), stderr: "" };
      }
      if (cmd.includes("pr merge")) {
        mergedAfterView = viewed;
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await landPr(exec, {
      repo: "o/r", gitRepo: "/repo", remote: "origin", branch: "afk/wX/9-x", target: "main", n: 9, title: "t",
      ciAwait: { sleep: async () => {} },
    });
    expect(r.ok).toBe(true);
    expect(viewed).toBe(true);
    expect(mergedAfterView).toBe(true);
  });

  it("returns ci-failed WITHOUT admin-merging when a required check failed", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      const cmd = argv.join(" ");
      if (cmd.includes("pr list")) return { code: 0, stdout: "5\n", stderr: "" };
      if (cmd.includes("pr view")) {
        return { code: 0, stdout: JSON.stringify({ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ state: "FAILURE" }] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await landPr(exec, {
      repo: "o/r", gitRepo: "/repo", remote: "origin", branch: "afk/wX/9-x", target: "main", n: 9, title: "t",
      ciAwait: { sleep: async () => {}, maxPolls: 2 },
    });
    expect(r).toEqual({ ok: false, prNumber: 5, reason: "ci-failed" });
    expect(calls.some((c) => c.join(" ").includes("pr merge"))).toBe(false);
  });

  it("returns ci-pending (no merge, no re-run) when checks stay pending", async () => {
    const exec: Exec = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd.includes("pr list")) return { code: 0, stdout: "5\n", stderr: "" };
      if (cmd.includes("pr view")) {
        return { code: 0, stdout: JSON.stringify({ mergeStateStatus: "BLOCKED", statusCheckRollup: [{ status: "IN_PROGRESS" }] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await landPr(exec, {
      repo: "o/r", gitRepo: "/repo", remote: "origin", branch: "afk/wX/9-x", target: "main", n: 9, title: "t",
      ciAwait: { sleep: async () => {}, maxPolls: 2 },
    });
    expect(r).toEqual({ ok: false, prNumber: 5, reason: "ci-pending" });
  });

  it("returns conflict on DIRTY (real merge conflict, distinct from ci)", async () => {
    const exec: Exec = async (argv) => {
      const cmd = argv.join(" ");
      if (cmd.includes("pr list")) return { code: 0, stdout: "5\n", stderr: "" };
      if (cmd.includes("pr view")) {
        return { code: 0, stdout: JSON.stringify({ mergeStateStatus: "DIRTY", statusCheckRollup: [] }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await landPr(exec, {
      repo: "o/r", gitRepo: "/repo", remote: "origin", branch: "afk/wX/9-x", target: "main", n: 9, title: "t",
      ciAwait: { sleep: async () => {} },
    });
    expect(r).toEqual({ ok: false, prNumber: 5, reason: "conflict" });
  });

  it("does NOT poll merge state by default (ciAwait absent)", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.join(" ").includes("pr list"), result: { stdout: "42\n" } },
    ]);
    const r = await landPr(exec, {
      repo: "o/r", gitRepo: "/repo", remote: "origin", branch: "afk/wX/9-x", target: "main", n: 9, title: "t",
    });
    expect(r.ok).toBe(true);
    expect(joined(calls).some((c) => c.includes("pr view"))).toBe(false);
    expect(joined(calls).some((c) => c.includes("pr merge 42 --admin --merge"))).toBe(true);
  });
});

describe("resolveMergeConflict (one-shot self-resolver)", () => {
  // unmerged-paths and MERGE_HEAD reads drive the verdict; the resolver itself
  // only side-effects the checkout (faked).
  function exec(
    over: { unmerged?: string; mergeHeadCode?: number } = {},
  ): { exec: Exec; calls: string[][] } {
    const calls: string[][] = [];
    const e: Exec = async (argv) => {
      calls.push(argv);
      const j = argv.join(" ");
      if (j.includes("status")) return { code: 0, stdout: "On branch main\nUnmerged paths", stderr: "" };
      if (j.includes("diff --name-only --diff-filter=U")) {
        return { code: 0, stdout: over.unmerged ?? "", stderr: "" };
      }
      if (j.includes("diff")) return { code: 0, stdout: "<<<<<<< conflict\n=======\n>>>>>>>", stderr: "" };
      if (j.includes("rev-parse -q --verify MERGE_HEAD")) {
        return { code: over.mergeHeadCode ?? 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    return { exec: e, calls };
  }

  const input = { repo: "/repo", branch: "afk/wX/9-x", n: 9, title: "fix", target: "main" };

  it("returns resolved when no unmerged paths remain and MERGE_HEAD is cleared", async () => {
    const { exec: e } = exec({ unmerged: "", mergeHeadCode: 1 });
    let prompt = "";
    const r = await resolveMergeConflict(e, async (p) => { prompt = p; }, input);
    expect(r.resolved).toBe(true);
    // the resolver was dispatched with a prompt carrying the branch + issue.
    expect(prompt).toContain("afk/wX/9-x");
    expect(prompt).toContain("#9");
  });

  it("falls back (unmerged-paths) when conflicts remain after the runner", async () => {
    const { exec: e } = exec({ unmerged: "src/x.ts\n", mergeHeadCode: 0 });
    const r = await resolveMergeConflict(e, async () => {}, input);
    expect(r).toEqual({ resolved: false, reason: "unmerged-paths" });
  });

  it("falls back (uncommitted-merge) when the merge was left uncommitted", async () => {
    // no unmerged paths, but MERGE_HEAD still verifies (rc 0) → merge not committed.
    const { exec: e } = exec({ unmerged: "", mergeHeadCode: 0 });
    const r = await resolveMergeConflict(e, async () => {}, input);
    expect(r).toEqual({ resolved: false, reason: "uncommitted-merge" });
  });

  it("still verifies git state when the runner throws (best-effort dispatch)", async () => {
    const { exec: e } = exec({ unmerged: "", mergeHeadCode: 1 });
    const r = await resolveMergeConflict(e, async () => { throw new Error("runner blew up"); }, input);
    expect(r.resolved).toBe(true);
  });

  it("truncates the diff context to 400 lines in the prompt", () => {
    const diff = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const prompt = buildConflictPrompt(input, "status", diff);
    expect(prompt).toContain("line 0");
    expect(prompt).toContain("line 399");
    expect(prompt).not.toContain("line 400");
  });

  it("instructs the resolver to commit with --no-verify (bypass consumer hooks, #840)", () => {
    const prompt = buildConflictPrompt(input, "status", "diff");
    expect(prompt).toContain("git commit --no-edit --no-verify");
  });
});

describe("preMergeRebase (#1006)", () => {
  const base = { repo: "/wt", remote: "origin", base: "main", branch: "afk/w/9-x" };

  it("clean rebase → fetches base, rebases, force-pushes the branch, ok", async () => {
    const { exec, calls } = fakeExec();
    const r = await preMergeRebase(exec, base);
    expect(r).toEqual({ ok: true });
    const j = joined(calls);
    expect(j).toContain("git -C /wt fetch origin main --quiet");
    expect(j).toContain("git -C /wt rebase origin/main");
    expect(j).toContain("git -C /wt push origin HEAD:refs/heads/afk/w/9-x --force-with-lease");
    // A clean rebase never aborts.
    expect(j.some((c) => c.includes("rebase --abort"))).toBe(false);
  });

  it("a fetch failure short-circuits before any rebase", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("fetch"), result: { code: 1 } },
    ]);
    const r = await preMergeRebase(exec, base);
    expect(r).toEqual({ ok: false, reason: "fetch-failed" });
    expect(joined(calls).some((c) => c.includes("rebase"))).toBe(false);
  });

  it("a rebase conflict aborts the rebase and never pushes → conflict", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.join(" ") === "git -C /wt rebase origin/main", result: { code: 1 } },
    ]);
    const r = await preMergeRebase(exec, base);
    expect(r).toEqual({ ok: false, reason: "conflict" });
    const j = joined(calls);
    expect(j).toContain("git -C /wt rebase --abort");
    expect(j.some((c) => c.includes("push"))).toBe(false);
  });

  it("a force-with-lease reject retries (re-fetch + re-rebase) then succeeds on the 2nd push", async () => {
    let pushes = 0;
    const { exec, calls } = fakeExec([
      {
        match: (a) => a.includes("push"),
        result: { code: 1 },
      },
    ]);
    // Wrap to make the 2nd push succeed.
    const wrapped: typeof exec = async (argv) => {
      if (argv.includes("push")) {
        pushes++;
        return { code: pushes >= 2 ? 0 : 1, stdout: "", stderr: "" };
      }
      return exec(argv);
    };
    const r = await preMergeRebase(wrapped, base);
    expect(r).toEqual({ ok: true });
    expect(pushes).toBe(2);
    // A retry re-fetches + re-rebases the advanced base between pushes.
    const fetches = joined(calls).filter((c) => c.includes("fetch")).length;
    expect(fetches).toBeGreaterThanOrEqual(2);
  });

  it("force-with-lease rejected on every attempt → retries twice then push-rejected (3 pushes)", async () => {
    let pushes = 0;
    const exec: Exec = async (argv) => {
      if (argv.includes("push")) {
        pushes++;
        return { code: 1, stdout: "", stderr: "rejected" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await preMergeRebase(exec, { ...base, maxPushRetries: 2 });
    expect(r).toEqual({ ok: false, reason: "push-rejected" });
    expect(pushes).toBe(3);
  });

  it("a re-rebase during retry that conflicts → conflict (bounded, no infinite retry)", async () => {
    let rebases = 0;
    const exec: Exec = async (argv) => {
      const j = argv.join(" ");
      if (j === "git -C /wt rebase origin/main") {
        rebases++;
        // First rebase clean; the retry's re-rebase conflicts.
        return { code: rebases >= 2 ? 1 : 0, stdout: "", stderr: "" };
      }
      if (argv.includes("push")) return { code: 1, stdout: "", stderr: "rejected" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await preMergeRebase(exec, base);
    expect(r).toEqual({ ok: false, reason: "conflict" });
  });
});
