import { describe, expect, it } from "vitest";
import { renderTrunkSyncNote, syncTrunkIntoBranch } from "../src/core/trunk-sync.js";
import type { Exec, ExecResult } from "../src/core/merge.js";

/** Same shape as the merge-suite fake: reply from the first matching rule. */
function fakeExec(
  rules: Array<{ match: (argv: string[]) => boolean; result: Partial<ExecResult> }> = [],
): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    for (const rule of rules) {
      if (rule.match(argv)) return { code: 0, stdout: "", stderr: "", ...rule.result };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

const joined = (calls: string[][]): string[] => calls.map((c) => c.join(" "));
const input = { repo: "/wt", remote: "origin", base: "main" };
const behindBy = (n: number) => ({
  match: (a: string[]) => a.includes("rev-list"),
  result: { code: 0, stdout: `${n}\n` },
});

describe("syncTrunkIntoBranch (#2481)", () => {
  it("merges a moved trunk into the working branch", async () => {
    const { exec, calls } = fakeExec([behindBy(10)]);
    const r = await syncTrunkIntoBranch(exec, input);
    expect(r).toEqual({ status: "synced", behind: 10 });
    const j = joined(calls);
    expect(j).toContain("git -C /wt fetch origin main --quiet");
    expect(j).toContain("git -C /wt merge --no-edit --no-verify origin/main");
    expect(j.some((c) => c.includes("merge --abort"))).toBe(false);
  });

  it("an up-to-date branch never merges", async () => {
    const { exec, calls } = fakeExec([behindBy(0)]);
    const r = await syncTrunkIntoBranch(exec, input);
    expect(r).toEqual({ status: "current", behind: 0 });
    expect(joined(calls).some((c) => c.includes("merge"))).toBe(false);
  });

  it("a conflicting merge is aborted so the worktree stays usable", async () => {
    const { exec, calls } = fakeExec([
      behindBy(10),
      { match: (a) => a.includes("merge") && a.includes("--no-edit"), result: { code: 1 } },
    ]);
    const r = await syncTrunkIntoBranch(exec, input);
    expect(r).toEqual({ status: "conflict", behind: 10 });
    expect(joined(calls)).toContain("git -C /wt merge --abort");
  });

  it("uncommitted work is never merged over", async () => {
    const { exec, calls } = fakeExec([
      behindBy(10),
      { match: (a) => a.includes("--porcelain"), result: { code: 0, stdout: " M apps/plugin-dev/src/x.ts\n" } },
    ]);
    const r = await syncTrunkIntoBranch(exec, input);
    expect(r).toEqual({ status: "dirty", behind: 10 });
    expect(joined(calls).some((c) => c.includes("merge --no-edit"))).toBe(false);
  });

  it("a failed fetch short-circuits before any probe", async () => {
    const { exec, calls } = fakeExec([{ match: (a) => a.includes("fetch"), result: { code: 1 } }]);
    const r = await syncTrunkIntoBranch(exec, input);
    expect(r).toEqual({ status: "failed" });
    expect(joined(calls).some((c) => c.includes("rev-list"))).toBe(false);
  });

  it("an unreadable behind-count never merges blind", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("rev-list"), result: { code: 0, stdout: "not-a-number\n" } },
    ]);
    const r = await syncTrunkIntoBranch(exec, input);
    expect(r).toEqual({ status: "failed" });
    expect(joined(calls).some((c) => c.includes("merge"))).toBe(false);
  });
});

describe("renderTrunkSyncNote (#2481)", () => {
  it("a conflict becomes the agent's FIRST instruction", () => {
    const note = renderTrunkSyncNote({ status: "conflict", behind: 12 }, "main");
    expect(note).toContain("FIRST");
    expect(note).toContain("git merge origin/main");
    expect(note).toContain("12 commit(s)");
  });

  it("a completed sync warns that files moved under the agent", () => {
    expect(renderTrunkSyncNote({ status: "synced", behind: 3 }, "main")).toContain("3 commit(s)");
  });

  it("dirty asks the agent to commit and merge itself", () => {
    expect(renderTrunkSyncNote({ status: "dirty", behind: 3 }, "main")).toContain("Commit your work");
  });

  it("a no-op sync says nothing", () => {
    expect(renderTrunkSyncNote({ status: "current", behind: 0 }, "main")).toBeUndefined();
    expect(renderTrunkSyncNote({ status: "failed" }, "main")).toBeUndefined();
  });
});
