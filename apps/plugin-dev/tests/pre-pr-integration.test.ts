import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { integrateBaseBeforePr } from "../src/core/pre-pr-integration.js";
import type { Exec, ExecResult } from "../src/core/merge.js";

/**
 * Recording fake Exec: replies from the first matching rule, success otherwise,
 * so a test only overrides the calls whose exit code drives a decision.
 */
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

describe("integrateBaseBeforePr", () => {
  it("short-circuits when the base is already an ancestor of the branch tip", async () => {
    const { exec, calls } = fakeExec();
    const result = await integrateBaseBeforePr(exec, {
      repo: "/rwt",
      remote: "origin",
      base: "main",
      branch: "afk/9-x",
    });
    expect(result).toEqual({ ok: true, action: "already-integrated" });
    expect(joined(calls)).toEqual([
      "git -C /rwt fetch origin main --quiet",
      "git -C /rwt merge-base --is-ancestor origin/main HEAD",
    ]);
  });

  it("merges the fetched base and publishes the integrated tip on the branch", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("--is-ancestor"), result: { code: 1 } },
    ]);
    const result = await integrateBaseBeforePr(exec, {
      repo: "/rwt",
      remote: "origin",
      base: "main",
      branch: "afk/9-x",
    });
    expect(result).toEqual({ ok: true, action: "merged" });
    expect(joined(calls)).toContain("git -C /rwt merge --no-edit origin/main");
    expect(joined(calls)).toContain("git -C /rwt push origin HEAD:refs/heads/afk/9-x");
  });

  it("names the conflicting paths and aborts the merge, leaving the branch untouched", async () => {
    const { exec, calls } = fakeExec([
      { match: (a) => a.includes("--is-ancestor"), result: { code: 1 } },
      { match: (a) => a.includes("merge") && a.includes("--no-edit"), result: { code: 1 } },
      { match: (a) => a.includes("--diff-filter=U"), result: { stdout: "src/a.ts\nsrc/b.ts\n" } },
    ]);
    const result = await integrateBaseBeforePr(exec, {
      repo: "/rwt",
      remote: "origin",
      base: "main",
      branch: "afk/9-x",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("conflict");
    expect(result.conflictPaths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.message).toContain("src/a.ts");
    expect(joined(calls)).toContain("git -C /rwt merge --abort");
    // A conflicted integration NEVER publishes anything.
    expect(joined(calls).some((c) => c.includes("push"))).toBe(false);
  });

  it("reports a failed fetch as infrastructure, never as a conflict", async () => {
    const { exec, calls } = fakeExec([{ match: (a) => a.includes("fetch"), result: { code: 128 } }]);
    const result = await integrateBaseBeforePr(exec, {
      repo: "/rwt",
      remote: "origin",
      base: "main",
      branch: "afk/9-x",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("fetch-failed");
    expect(result.message).toContain("could not fetch origin/main");
    expect(joined(calls).some((c) => c.includes("merge"))).toBe(false);
  });

  it("reports a rejected push as infrastructure, never as a conflict", async () => {
    const { exec } = fakeExec([
      { match: (a) => a.includes("--is-ancestor"), result: { code: 1 } },
      { match: (a) => a.includes("push"), result: { code: 1 } },
    ]);
    const result = await integrateBaseBeforePr(exec, {
      repo: "/rwt",
      remote: "origin",
      base: "main",
      branch: "afk/9-x",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("push-failed");
  });
});

// ---------------------------------------------------------------------------
// Real-repository fixture (#2936): a base that MOVED under a worker branch.
//
// This is the situation PRs #2933/#2934 were born in — the PR opened on the
// boot-time base and the conflict only surfaced at landing time, with the worker
// dead. The fixture reproduces the moved base and asserts the verdict lands here
// instead, on a real git, with a real conflict and a real remote.
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  work: string;
  originDir: string;
  git: (cwd: string, ...args: string[]) => string;
}

const BRANCH = "afk/2936-base-moved";

const realExec: Exec = async (argv) => {
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), { encoding: "utf8", stdio: "pipe" });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/**
 * Seed a bare `origin` carrying `main` plus a worker branch forked from it, and
 * a working clone checked out on the worker branch at its remote tip.
 * `baseChange` is committed on `main` AFTER the fork — that is the base moving.
 */
async function seedMovedBase(baseChange: { file: string; content: string }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pre-pr-integration-"));
  const originDir = join(root, "origin.git");
  const seed = join(root, "seed");
  const work = join(root, "work");
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: "pipe" });

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir], { stdio: "pipe" });
  execFileSync("git", ["clone", "-q", originDir, seed], { stdio: "pipe" });
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");

  await writeFile(join(seed, "shared.ts"), "export const value = 'base';\n");
  await writeFile(join(seed, "untouched.ts"), "export const other = 1;\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "seed the base");
  git(seed, "push", "-q", "origin", "main");

  // The worker forks here and edits `shared.ts`.
  git(seed, "checkout", "-q", "-b", BRANCH);
  await writeFile(join(seed, "shared.ts"), "export const value = 'worker';\n");
  git(seed, "commit", "-qam", "worker slice");
  git(seed, "push", "-q", "origin", BRANCH);

  // The base MOVES after the fork.
  git(seed, "checkout", "-q", "main");
  await writeFile(join(seed, baseChange.file), baseChange.content);
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "the base moved");
  git(seed, "push", "-q", "origin", "main");

  // The isolated worktree the integration runs in: pinned to the REMOTE tip of
  // the worker branch, exactly as the engine provisions it.
  execFileSync("git", ["clone", "-q", "--branch", BRANCH, originDir, work], { stdio: "pipe" });
  git(work, "config", "user.email", "test@example.com");
  git(work, "config", "user.name", "Test");

  return { root, work, originDir, git };
}

describe("integrateBaseBeforePr against a real repository whose base moved", () => {
  it("reports the conflict BEFORE the PR exists and leaves origin's branch untouched", async () => {
    const fx = await seedMovedBase({ file: "shared.ts", content: "export const value = 'base moved';\n" });
    try {
      const before = fx.git(fx.originDir, "rev-parse", BRANCH).trim();

      const result = await integrateBaseBeforePr(realExec, {
        repo: fx.work,
        remote: "origin",
        base: "main",
        branch: BRANCH,
      });

      expect(result.ok).toBe(false);
      expect(result.reason).toBe("conflict");
      expect(result.conflictPaths).toEqual(["shared.ts"]);
      expect(result.message).toContain("shared.ts");

      // The merge was aborted: no conflict markers survive, no half-merged state.
      expect(fx.git(fx.work, "status", "--porcelain").trim()).toBe("");
      // Nothing was published — the branch on origin is exactly what it was.
      expect(fx.git(fx.originDir, "rev-parse", BRANCH).trim()).toBe(before);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("births the branch integrated when the moved base does not conflict", async () => {
    const fx = await seedMovedBase({ file: "added-by-base.ts", content: "export const added = true;\n" });
    try {
      const result = await integrateBaseBeforePr(realExec, {
        repo: fx.work,
        remote: "origin",
        base: "main",
        branch: BRANCH,
      });

      expect(result).toEqual({ ok: true, action: "merged" });
      // THE point of the earlier barrier: the branch a PR would be opened from
      // already carries the current base. Before the fix this only became true
      // at landing time, through preMergeRebase.
      expect(
        await realExec(["git", "-C", fx.work, "merge-base", "--is-ancestor", "origin/main", `origin/${BRANCH}`]),
      ).toMatchObject({ code: 0 });
      // And the worker's own change survived the integration.
      expect(fx.git(fx.work, "show", `origin/${BRANCH}:shared.ts`)).toContain("'worker'");
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });

  it("no-ops when the base has not moved", async () => {
    const fx = await seedMovedBase({ file: "added-by-base.ts", content: "export const added = true;\n" });
    try {
      // Integrate once, then again: the second run has nothing left to do.
      await integrateBaseBeforePr(realExec, { repo: fx.work, remote: "origin", base: "main", branch: BRANCH });
      const tip = fx.git(fx.originDir, "rev-parse", BRANCH).trim();

      const again = await integrateBaseBeforePr(realExec, {
        repo: fx.work,
        remote: "origin",
        base: "main",
        branch: BRANCH,
      });

      expect(again).toEqual({ ok: true, action: "already-integrated" });
      expect(fx.git(fx.originDir, "rev-parse", BRANCH).trim()).toBe(tip);
    } finally {
      await rm(fx.root, { recursive: true, force: true });
    }
  });
});
