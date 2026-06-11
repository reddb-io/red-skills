import { describe, expect, it } from "vitest";
import {
  integrateOrigin,
  landMerge,
  landPr,
  resolveMergeConflict,
  buildConflictPrompt,
  waitForReviewCheck,
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
    expect(joined(calls)).toContain('git -C /repo merge --no-ff afk/wAAAA/9-x -m merge: #9 do thing');
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
});
