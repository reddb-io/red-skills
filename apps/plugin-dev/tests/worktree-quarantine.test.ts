import { execFile } from "node:child_process";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runOperationalProbes } from "../src/core/operational-probes.js";
import { quarantineBrokenWorktrees } from "../src/runtime/git.js";
import { collectBootPrecheckFacts } from "../src/runtime/wire/boot.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function setupRepo(): Promise<{ repo: string; worktree: string }> {
  const root = await mkdtemp(join(tmpdir(), "boot-worktree-quarantine-"));
  const remote = join(root, "origin.git");
  const repo = join(root, "repo");
  const worktree = join(root, "worker-worktree");

  await git(root, ["init", "--bare", "--initial-branch=main", remote]);
  await git(root, ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "agent@example.test"]);
  await git(repo, ["config", "user.name", "Agent"]);
  await writeFile(join(repo, "tracked.txt"), "initial\n", "utf8");
  await git(repo, ["add", "tracked.txt"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["remote", "add", "origin", remote]);
  await git(repo, ["push", "-u", "origin", "main"]);
  await git(repo, ["worktree", "add", "-b", "afk/test/2473-broken", worktree, "HEAD"]);

  return { repo, worktree };
}

async function poisonWorktree(repo: string): Promise<void> {
  const gitDir = await git(repo, ["rev-parse", "--absolute-git-dir"]);
  const [entryName] = await readdir(join(gitDir, "worktrees"));
  const entry = join(gitDir, "worktrees", entryName!);
  await writeFile(join(entry, "locked"), "initializing\n", "utf8");
  await writeFile(join(entry, "HEAD"), `${"0".repeat(40)}\n`, "utf8");
}

describe("boot worktree quarantine", () => {
  it("quarantines an initializing locked worktree with a dangling HEAD before git probes", async () => {
    const { repo, worktree } = await setupRepo();
    await poisonWorktree(repo);

    const result = await quarantineBrokenWorktrees({ cwd: repo });

    expect(result).toEqual([
      {
        path: worktree,
        reason: "initializing-lock,dangling-head",
        removed: true,
      },
    ]);
    expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
    await expect(git(repo, ["fetch", "origin", "main"])).resolves.toBe("");
  });

  it("runs quarantine before collecting operational probe facts", async () => {
    const { repo, worktree } = await setupRepo();
    await poisonWorktree(repo);
    const log: string[] = [];

    const facts = await collectBootPrecheckFacts(
      { root: repo, repo: "", remote: "origin" },
      { log: (line) => log.push(line) },
    );
    const probes = await runOperationalProbes(facts);

    expect(probes.findings.map((finding) => finding.id)).not.toContain("afk.base-freshness");
    expect(await git(repo, ["worktree", "list", "--porcelain"])).not.toContain(worktree);
    expect(log).toEqual([
      `boot janitor quarantined worktree path=${worktree} reason=initializing-lock,dangling-head`,
    ]);
  });
});
