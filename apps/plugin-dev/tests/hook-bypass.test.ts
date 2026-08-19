// hook-bypass.test.ts — issue #840.
//
// AFK must run its commits with the CONSUMER repo's git hooks bypassed, while
// keeping its own post-commit push. The mechanism is the onWorktreeReady host
// hook (buildContinuousPushHook): after the worktree exists, it installs AFK's
// post-commit hook into an AFK-owned hooks dir and redirects the worktree's
// `core.hooksPath` there (worktree-scoped, so the primary checkout is untouched).
//
// These are REAL-git E2E tests: they run the actual generated shell against a
// throwaway repo+worktree so the bypass is proven end-to-end, not just by
// string-matching the script.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContinuousPushHook } from "../src/core/execution.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Run the generated `sh -c '<script>'` host command in `cwd` (the worktree). */
function runHostHook(command: string, cwd: string): void {
  execFileSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
}

describe("AFK commit-phase hook bypass (issue #840)", () => {
  it("bypasses a consumer pre-commit hook on AFK commits while the post-commit push still fires", () => {
    const root = mkdtempSync(join(tmpdir(), "afk-hook-bypass-"));
    try {
      // A bare remote the AFK post-commit hook pushes to.
      const remote = join(root, "remote.git");
      git(root, "init", "--bare", "-q", remote);

      // The consumer repo with a pre-commit hook that drops a sentinel. The hook
      // lives in the COMMON gitdir (.git/hooks) — exactly where husky/lefthook
      // land — which is what core.hooksPath must shadow.
      const repo = join(root, "consumer");
      git(root, "init", "-q", "-b", "main", repo);
      git(repo, "config", "user.email", "t@t");
      git(repo, "config", "user.name", "t");
      git(repo, "remote", "add", "origin", remote);
      writeFileSync(join(repo, "seed.txt"), "seed\n");
      git(repo, "add", "seed.txt");
      git(repo, "commit", "-qm", "seed");

      const precommitFlag = join(root, "precommit.fired");
      const postcheckoutFlag = join(root, "postcheckout.fired");
      const hookDir = join(repo, ".git", "hooks");
      mkdirSync(hookDir, { recursive: true });
      writeFileSync(join(hookDir, "pre-commit"), `#!/bin/sh\necho fired > "${precommitFlag}"\n`);
      chmodSync(join(hookDir, "pre-commit"), 0o755);
      // A consumer post-checkout (the needed one — e.g. submodule init) must
      // still fire at worktree-creation time; the bypass is commit-phase only.
      writeFileSync(join(hookDir, "post-checkout"), `#!/bin/sh\necho fired > "${postcheckoutFlag}"\n`);
      chmodSync(join(hookDir, "post-checkout"), 0o755);

      // Create the AFK worktree on the worker branch. `git worktree add` fires
      // the consumer post-checkout — proving worktree-creation hooks still run.
      const branch = "afk/wTEST/840-slug";
      const wt = join(root, "wt");
      git(repo, "worktree", "add", "-q", wt, "-b", branch);
      expect(existsSync(postcheckoutFlag)).toBe(true);

      // Run the REAL onWorktreeReady host hook in the worktree (initial push +
      // post-commit install + core.hooksPath redirect).
      runHostHook(buildContinuousPushHook(branch, "origin").command, wt);

      // Simulate the inner agent's per-file commit.
      writeFileSync(join(wt, "feature.txt"), "x\n");
      git(wt, "add", "feature.txt");
      git(wt, "commit", "-qm", "feat: x\n\nRefs #840");

      // The consumer pre-commit hook was bypassed for the AFK commit.
      expect(existsSync(precommitFlag)).toBe(false);

      // AFK's own post-commit push fired: the remote carries the worktree HEAD.
      const wtHead = git(wt, "rev-parse", "HEAD");
      const remoteHead = execFileSync("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`], {
        encoding: "utf8",
      }).trim();
      expect(remoteHead).toBe(wtHead);

      // The redirect is worktree-scoped: a commit in the PRIMARY checkout still
      // fires the consumer pre-commit hook (the primary is sacred, untouched).
      writeFileSync(join(repo, "primary.txt"), "y\n");
      git(repo, "add", "primary.txt");
      git(repo, "commit", "-qm", "primary change");
      expect(existsSync(precommitFlag)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
