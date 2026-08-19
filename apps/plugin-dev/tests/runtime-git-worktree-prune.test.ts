import { execFile } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { worktreePrune } from "../src/runtime/git.js";

const execFileP = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

async function ageTree(path: string, date: Date): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await ageTree(child, date);
    else await utimes(child, date, date);
  }
  await utimes(path, date, date);
}

describe("worktreePrune", () => {
  it("preserves a sibling birth while reaping an aged stale registration", async () => {
    const root = await mkdtemp(join(tmpdir(), "worktree-prune-grace-"));
    const repo = join(root, "repo");
    const youngWorktree = join(root, "young-birth");
    const oldWorktree = join(root, "old-stale");
    const pausedYoungWorktree = join(root, "paused-young-birth");
    const removedOldWorktree = join(root, "removed-old-stale");

    try {
      await git(root, ["init", "--initial-branch=main", repo]);
      await git(repo, ["config", "user.email", "agent@example.test"]);
      await git(repo, ["config", "user.name", "Agent"]);
      await writeFile(join(repo, "base.txt"), "base\n");
      await git(repo, ["add", "base.txt"]);
      await git(repo, ["commit", "-m", "initial"]);

      await git(repo, ["worktree", "add", "-b", "young-birth", youngWorktree]);
      await git(repo, ["worktree", "add", "-b", "old-stale", oldWorktree]);
      await rename(youngWorktree, pausedYoungWorktree);
      await rename(oldWorktree, removedOldWorktree);

      const registrations = join(repo, ".git", "worktrees");
      const youngRegistration = join(registrations, "young-birth");
      const oldRegistration = join(registrations, "old-stale");
      await ageTree(oldRegistration, new Date(Date.now() - 2 * 60 * 60 * 1_000));

      await worktreePrune({ cwd: repo });

      await expect(stat(youngRegistration)).resolves.toBeDefined();
      await expect(stat(oldRegistration)).rejects.toMatchObject({ code: "ENOENT" });

      // Finish the posed sibling birth after the boot-time prune. Its checkout
      // remains usable only when the young registration survived the race.
      await rename(pausedYoungWorktree, youngWorktree);
      await expect(git(youngWorktree, ["status", "--short"])).resolves.toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
