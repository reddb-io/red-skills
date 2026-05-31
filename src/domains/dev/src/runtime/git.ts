// runtime/git.ts — concrete `git` closures backed by exec.ts.
//
// Provides the precheck facts (is-repo / remotes / current branch / main
// presence), the branch-listing the reap command classifies, and the GitExec /
// merge-Exec executors the orchestrators inject. Every call routes through
// runtime/exec.ts's `git` helper.

import { execTool, type ExecOptions, type ExecFn, type ExecOutput } from "./exec.js";
import type { GitExec, GitExecResult } from "../core/remote-branch.js";
import type { Exec as MergeExec, ExecResult as MergeExecResult } from "../core/merge.js";
import type { BranchRef } from "../core/branch-cleanup.js";

export interface GitContext {
  /** The primary checkout dir. */
  cwd: string;
  /**
   * Optional injected exec boundary. Unset in production (the real `execTool`
   * runs). Set in tests to a recording fake so the REAL git closure assembly —
   * including the gitExec/mergeExec executors merge.ts and remote-branch.ts run
   * through — can be driven without touching the OS. See exec.ts::ExecFn.
   */
  exec?: ExecFn;
}

function opts(ctx: GitContext): ExecOptions {
  return { cwd: ctx.cwd };
}

/**
 * Dispatch a `git <args>` invocation through the injected exec when present, else
 * the real `execTool`. Single seam every git closure in this module routes
 * through; the default path is byte-for-byte the prior static `git` helper call.
 */
function runGit(ctx: GitContext, args: readonly string[]): Promise<ExecOutput> {
  return (ctx.exec ?? execTool)("git", args, opts(ctx));
}

export async function isGitRepo(ctx: GitContext): Promise<boolean> {
  const r = await runGit(ctx, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Deduped remote URLs from `git remote -v`. */
export async function remoteUrls(ctx: GitContext): Promise<string[]> {
  const r = await runGit(ctx, ["remote", "-v"]);
  if (r.code !== 0) return [];
  const urls = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1]) urls.add(parts[1]);
  }
  return [...urls];
}

export async function hasMainBranch(ctx: GitContext): Promise<boolean> {
  const r = await runGit(ctx, ["rev-parse", "--verify", "--quiet", "refs/heads/main"]);
  return r.code === 0;
}

export async function currentBranch(ctx: GitContext): Promise<string> {
  const r = await runGit(ctx, ["branch", "--show-current"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** `git -C cwd rev-parse --short HEAD`. */
export async function headShortSha(ctx: GitContext): Promise<string> {
  const r = await runGit(ctx, ["rev-parse", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** Delete a local branch (git branch -D). Best-effort. */
export async function deleteLocalBranch(ctx: GitContext, branch: string): Promise<void> {
  if (!branch) return;
  await runGit(ctx, ["branch", "-D", branch]);
}

/** Delete an origin branch (git push origin --delete). Best-effort. */
export async function deleteRemoteBranch(ctx: GitContext, branch: string): Promise<void> {
  if (!branch) return;
  await runGit(ctx, ["push", "origin", "--delete", branch]);
}

/** Changed files of <branch> vs <base> (git diff --name-only base...branch). */
export async function changedFiles(ctx: GitContext, branch: string, base: string): Promise<string[]> {
  const r = await runGit(ctx, ["diff", "--name-only", `${base}...${branch}`]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Diffstat summary line of <branch> vs <base>. */
export async function diffstat(ctx: GitContext, branch: string, base: string): Promise<string> {
  const r = await runGit(ctx, ["diff", "--shortstat", `${base}...${branch}`]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * Parsed `git diff --shortstat <base>` from the working tree at `ctx.cwd`.
 * Mirrors statusline.sh's worktree diffstat fallback: extracts the
 * `N insertion` / `N deletion` integers, defaulting each to 0 when absent or
 * on any failure.
 */
export async function diffstatShortstat(ctx: GitContext, base: string): Promise<{ added: number; removed: number }> {
  const r = await runGit(ctx, ["diff", "--shortstat", base]);
  if (r.code !== 0) return { added: 0, removed: 0 };
  const ins = /(\d+) insertion/.exec(r.stdout);
  const del = /(\d+) deletion/.exec(r.stdout);
  return { added: ins ? Number(ins[1]) : 0, removed: del ? Number(del[1]) : 0 };
}

/** `git log -n <count>` one-line block for a ref (the inner-prompt recent
 * commits block). Best-effort: empty string when the ref/log is unavailable. */
export async function recentCommits(ctx: GitContext, ref = "main", count = 5): Promise<string> {
  const r = await runGit(ctx, ["log", "-n", String(count), "--oneline", ref]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * Add a detached worktree for `branch` under `path` (fetching origin first so a
 * sandcastle-pushed worker branch is visible locally). Returns true on success.
 * Best-effort cleanup is the caller's via {@link worktreeRemove}.
 */
export async function worktreeAdd(ctx: GitContext, path: string, branch: string): Promise<boolean> {
  await runGit(ctx, ["fetch", "origin", branch]);
  // Prefer the local branch if it exists, else the fetched origin ref.
  const local = await runGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const ref = local.code === 0 ? branch : `origin/${branch}`;
  const r = await runGit(ctx, ["worktree", "add", "--force", "--detach", path, ref]);
  return r.code === 0;
}

/** Remove a worktree previously added by {@link worktreeAdd} (best-effort). */
export async function worktreeRemove(ctx: GitContext, path: string): Promise<void> {
  if (!path) return;
  await runGit(ctx, ["worktree", "remove", "--force", path]);
}

/** The GitExec executor for remote-branch.ts (pushAttempt / deleteRemote). */
export function gitExec(ctx: GitContext): GitExec {
  return async (args: string[]): Promise<GitExecResult> => {
    const r = await runGit(ctx, args);
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

/** The merge.ts Exec executor (integrateOrigin / landMerge / landPr). */
export function mergeExec(ctx: GitContext): MergeExec {
  return async (args: string[]): Promise<MergeExecResult> => {
    // merge.ts passes a full argv whose head is "git" or "gh"; route both
    // through the same injectable seam so the test fake sees the real land
    // commands (git push / gh pr merge) the close path issues.
    const [head, ...rest] = args;
    const exec = ctx.exec ?? execTool;
    const r = await exec(head ?? "git", rest, opts(ctx));
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

// ---------- branch listing for the reap command ----------

/** List local branches matching a glob (e.g. "afk/*"), as bare ref names. */
export async function listLocalBranches(ctx: GitContext, pattern: string): Promise<string[]> {
  const r = await runGit(ctx, ["branch", "--list", pattern, "--format=%(refname:short)"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Local branches currently checked out (to exclude from the local reaper). */
export async function checkedOutBranches(ctx: GitContext): Promise<Set<string>> {
  const out = new Set<string>();
  const r = await runGit(ctx, ["worktree", "list", "--porcelain"]);
  if (r.code === 0) {
    for (const line of r.stdout.split("\n")) {
      const m = /^branch\s+refs\/heads\/(.+)$/.exec(line.trim());
      if (m && m[1]) out.add(m[1]);
    }
  }
  const cur = await currentBranch(ctx);
  if (cur) out.add(cur);
  return out;
}

/**
 * List origin refs under a namespace ("afk/" | "afk-attempts/") via ls-remote,
 * shaped as BranchRef[]. The optional last-commit epoch is left unset (the
 * snapshot 404 grace falls back to "keep" without it).
 */
export async function listRemoteBranches(ctx: GitContext, namespace: string): Promise<BranchRef[]> {
  const r = await runGit(ctx, ["ls-remote", "--heads", "origin", `refs/heads/${namespace}*`]);
  if (r.code !== 0) return [];
  const refs: BranchRef[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /\trefs\/heads\/(.+)$/.exec(line);
    if (m && m[1]) refs.push({ branch: m[1] });
  }
  return refs;
}
