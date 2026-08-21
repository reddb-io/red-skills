import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { measureWorktreeDiff, parseNumstat, WORKTREE_DIFF_TIMEOUT_MS } from "./worktree-diff.js";

const run = promisify(execFile);

describe("parseNumstat", () => {
  it("sums both sides of every text file git reported", () => {
    expect(parseNumstat("12\t3\ta.ts\n5\t0\tb.ts\n")).toEqual({ added: 17, removed: 3 });
  });

  it("skips a binary file rather than reading its dashes as zero", () => {
    // `Number("-")` is NaN, and one NaN poisons the whole total.
    expect(parseNumstat("4\t1\ta.ts\n-\t-\tlogo.png\n")).toEqual({ added: 4, removed: 1 });
  });

  it("answers a measured zero for an empty diff — not an absence", () => {
    expect(parseNumstat("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("measureWorktreeDiff", () => {
  it("gives the cell up rather than guessing when git cannot answer", async () => {
    const stat = await measureWorktreeDiff({
      worktree: "/nowhere",
      base: "main",
      exec: async (args) => ({ code: 1, stdout: args.join(" ") }),
    });
    expect(stat).toBeNull();
  });

  it("falls back to the base ref when there is no merge base", async () => {
    const seen: string[][] = [];
    const stat = await measureWorktreeDiff({
      worktree: "/w",
      base: "main",
      exec: async (args) => {
        seen.push([...args]);
        if (args[0] === "merge-base") return { code: 128, stdout: "" };
        return { code: 0, stdout: "9\t2\tsrc/a.ts\n" };
      },
    });
    expect(stat).toEqual({ added: 9, removed: 2 });
    expect(seen[1]).toEqual(["diff", "--numstat", "main"]);
  });

  it("bounds itself, so a stage transition never waits on a diff", () => {
    expect(WORKTREE_DIFF_TIMEOUT_MS).toBeGreaterThan(0);
    expect(WORKTREE_DIFF_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });
});

describe("measureWorktreeDiff against a real git worktree", () => {
  let repo = "";

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "red-worktree-diff-"));
    const git = (...args: string[]): Promise<unknown> => run("git", args, { cwd: repo });
    await git("init", "--initial-branch=main");
    await git("config", "user.email", "worker@example.test");
    await git("config", "user.name", "Worker");
    await writeFile(join(repo, "base.txt"), "one\ntwo\nthree\n");
    await git("add", ".");
    await git("commit", "-m", "base");
    await git("checkout", "-b", "red/worker/1");
    // Round one: committed.
    await writeFile(join(repo, "committed.ts"), "a\nb\nc\nd\n");
    await writeFile(join(repo, "base.txt"), "one\nthree\n");
    await git("add", ".");
    await git("commit", "-m", "round one");
    // Round two: still in the editor, exactly the state the cell must show.
    await writeFile(join(repo, "committed.ts"), "a\nb\nc\nd\ne\nf\n");
  });

  afterAll(async () => {
    if (repo !== "") await rm(repo, { recursive: true, force: true });
  });

  it("counts committed and uncommitted work, each line once", async () => {
    // 4 committed + 2 uncommitted added in committed.ts, 1 removed in base.txt.
    // The committed line that round two edited again is NOT counted twice.
    expect(await measureWorktreeDiff({ worktree: repo, base: "main" }))
      .toEqual({ added: 6, removed: 1 });
  });

  it("answers a measured zero on the base itself", async () => {
    await run("git", ["stash", "--include-untracked"], { cwd: repo });
    await run("git", ["checkout", "main"], { cwd: repo });
    expect(await measureWorktreeDiff({ worktree: repo, base: "main" }))
      .toEqual({ added: 0, removed: 0 });
  });
});
