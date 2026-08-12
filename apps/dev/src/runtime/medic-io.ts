import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { planGithubRestRead } from "@reddb-io/github";
import { git, gh, pnpm } from "./exec.js";
import type { MedicIo } from "../core/pr-medic.js";
import { inferGithubRepoSlug } from "./wire/github-slug.js";

const MEDIC_LOG_TAIL_CHARS = 4000;

/** The dev-host implementation of the PR medic's IO port (#2513). Each healing
 * round runs inside an isolated worktree under the registered feedback lane
 * (`.red/tmp/worktrees/feedback/medic-<pr>`), created on first use and removed
 * by `cleanup` whatever the outcome. */
export function createMedicIo(root: string, log?: (line: string) => void): MedicIo {
  const repo = inferGithubRepoSlug(root);
  const restPath = (suffix: string): string => `repos/${repo}/${suffix}`;
  const worktreeDir = (pr: number): string =>
    join(root, ".red", "tmp", "worktrees", "feedback", `medic-${pr}`);
  const branchOf = async (pr: number): Promise<string> => {
    const plan = planGithubRestRead({ kind: "pr", number: pr, fields: ["headRefName"], repo });
    if (plan.outcome !== "plan") throw new Error(plan.reason);
    const r = await gh(plan.args, { cwd: root });
    if (r.code !== 0) throw new Error(`gh pr view #${pr} failed: ${r.stderr.trim()}`);
    return String(plan.decode(r.stdout).headRefName ?? "");
  };
  const ensureWorktree = async (pr: number): Promise<string> => {
    const dir = worktreeDir(pr);
    const branch = await branchOf(pr);
    await git(["fetch", "origin", branch, "main"], { cwd: root });
    const added = await git(["worktree", "add", dir, `origin/${branch}`], { cwd: root });
    if (added.code !== 0 && !/already exists/.test(added.stderr)) {
      throw new Error(`worktree add for medic #${pr} failed: ${added.stderr.trim()}`);
    }
    await git(["checkout", "-B", branch, `origin/${branch}`], { cwd: dir });
    return dir;
  };

  return {
    async diagnose(pr) {
      const dir = await ensureWorktree(pr);
      // Failing-log tail from the newest failed run on the PR branch.
      let logTail = "";
      const branch = await branchOf(pr);
      const runsPlan = planGithubRestRead({
        kind: "rest",
        path: restPath("actions/runs"),
        args: ["-f", `branch=${branch}`, "-f", "status=failure", "-f", "per_page=5", "--jq", ".workflow_runs[].id"],
      });
      if (runsPlan.outcome !== "plan") throw new Error(runsPlan.reason);
      const runs = await gh(runsPlan.args, { cwd: root });
      const failedRun = runs.stdout.trim().split("\n").filter(Boolean)[0];
      if (failedRun) {
        const logsPlan = planGithubRestRead({ kind: "rest", path: restPath(`actions/runs/${failedRun}/logs`) });
        if (logsPlan.outcome !== "plan") throw new Error(logsPlan.reason);
        const logs = await gh(logsPlan.args, { cwd: root });
        logTail = logs.stdout.slice(-MEDIC_LOG_TAIL_CHARS);
      }
      // Conflicts: attempt the merge from main; collect conflicted contents.
      const conflicts: Record<string, string> = {};
      const merged = await git(["merge", "origin/main", "--no-edit"], { cwd: dir });
      if (merged.code !== 0) {
        const listed = await git(["diff", "--name-only", "--diff-filter=U"], { cwd: dir });
        for (const path of listed.stdout.trim().split("\n").filter(Boolean)) {
          conflicts[path] = await readFile(join(dir, path), "utf8");
        }
      }
      // Changed files vs main for rename scanning (post-merge tree when clean).
      const files: Record<string, string> = {};
      if (merged.code === 0) {
        const changed = await git(["diff", "--name-only", "origin/main...HEAD"], { cwd: dir });
        for (const path of changed.stdout.trim().split("\n").filter(Boolean).slice(0, 200)) {
          if (!/\.(ts|mts|mjs|js|md|json)$/.test(path)) continue;
          try {
            files[path] = await readFile(join(dir, path), "utf8");
          } catch {
            // deleted file — nothing to scan.
          }
        }
      }
      return { logTail, conflicts, files };
    },
    async regenPi(pr) {
      const dir = worktreeDir(pr);
      const install = await pnpm(["install", "--frozen-lockfile", "--prefer-offline"], { cwd: dir, timeoutMs: 600_000 });
      if (install.code !== 0) throw new Error(`pnpm install failed: ${install.stderr.slice(-400)}`);
      const build = await pnpm(["pi:packages:build"], { cwd: dir, timeoutMs: 600_000 });
      if (build.code !== 0) throw new Error(`pi:packages:build failed: ${build.stderr.slice(-400)}`);
      await pnpm(["pi:manifests"], { cwd: dir, timeoutMs: 300_000 });
    },
    async writeFile(pr, path, text) {
      await writeFile(join(worktreeDir(pr), path), text, "utf8");
    },
    async commitPush(pr, message) {
      const dir = worktreeDir(pr);
      await git(["add", "-A"], { cwd: dir });
      const committed = await git(["commit", "-m", message], { cwd: dir });
      if (committed.code !== 0 && !/nothing to commit/.test(committed.stdout + committed.stderr)) {
        throw new Error(`medic commit for #${pr} failed: ${committed.stderr.trim()}`);
      }
      const pushed = await git(["push", "origin", "HEAD"], { cwd: dir });
      if (pushed.code !== 0) throw new Error(`medic push for #${pr} failed: ${pushed.stderr.trim()}`);
    },
    async cleanup(pr) {
      await git(["worktree", "remove", "--force", worktreeDir(pr)], { cwd: root });
      await git(["worktree", "prune"], { cwd: root });
    },
    log,
  };
}
