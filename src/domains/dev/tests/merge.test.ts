import { describe, expect, it } from "vitest";
import {
  integrateOrigin,
  landMerge,
  landPr,
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
    expect(joined(calls)).toContain("git -C /repo push origin work-branch");
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
