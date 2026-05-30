// runtime/git.ts — concrete `git` closures backed by exec.ts.
//
// Provides the precheck facts (is-repo / remotes / current branch / main
// presence), the branch-listing the reap command classifies, and the GitExec /
// merge-Exec executors the orchestrators inject. Every call routes through
// runtime/exec.ts's `git` helper.

import { git, type ExecOptions } from "./exec.js";
import type { GitExec, GitExecResult } from "../core/remote-branch.js";
import type { Exec as MergeExec, ExecResult as MergeExecResult } from "../core/merge.js";
import type { BranchRef } from "../core/branch-cleanup.js";

export interface GitContext {
  /** The primary checkout dir. */
  cwd: string;
}

function opts(ctx: GitContext): ExecOptions {
  return { cwd: ctx.cwd };
}

export async function isGitRepo(ctx: GitContext): Promise<boolean> {
  const r = await git(["rev-parse", "--is-inside-work-tree"], opts(ctx));
  return r.code === 0 && r.stdout.trim() === "true";
}

/** Deduped remote URLs from `git remote -v`. */
export async function remoteUrls(ctx: GitContext): Promise<string[]> {
  const r = await git(["remote", "-v"], opts(ctx));
  if (r.code !== 0) return [];
  const urls = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2 && parts[1]) urls.add(parts[1]);
  }
  return [...urls];
}

export async function hasMainBranch(ctx: GitContext): Promise<boolean> {
  const r = await git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], opts(ctx));
  return r.code === 0;
}

export async function currentBranch(ctx: GitContext): Promise<string> {
  const r = await git(["branch", "--show-current"], opts(ctx));
  return r.code === 0 ? r.stdout.trim() : "";
}

/** `git -C cwd rev-parse --short HEAD`. */
export async function headShortSha(ctx: GitContext): Promise<string> {
  const r = await git(["rev-parse", "--short", "HEAD"], opts(ctx));
  return r.code === 0 ? r.stdout.trim() : "";
}

/** Delete a local branch (git branch -D). Best-effort. */
export async function deleteLocalBranch(ctx: GitContext, branch: string): Promise<void> {
  if (!branch) return;
  await git(["branch", "-D", branch], opts(ctx));
}

/** Delete an origin branch (git push origin --delete). Best-effort. */
export async function deleteRemoteBranch(ctx: GitContext, branch: string): Promise<void> {
  if (!branch) return;
  await git(["push", "origin", "--delete", branch], opts(ctx));
}

/** Changed files of <branch> vs <base> (git diff --name-only base...branch). */
export async function changedFiles(ctx: GitContext, branch: string, base: string): Promise<string[]> {
  const r = await git(["diff", "--name-only", `${base}...${branch}`], opts(ctx));
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Diffstat summary line of <branch> vs <base>. */
export async function diffstat(ctx: GitContext, branch: string, base: string): Promise<string> {
  const r = await git(["diff", "--shortstat", `${base}...${branch}`], opts(ctx));
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * Parsed `git diff --shortstat <base>` from the working tree at `ctx.cwd`.
 * Mirrors statusline.sh's worktree diffstat fallback: extracts the
 * `N insertion` / `N deletion` integers, defaulting each to 0 when absent or
 * on any failure.
 */
export async function diffstatShortstat(ctx: GitContext, base: string): Promise<{ added: number; removed: number }> {
  const r = await git(["diff", "--shortstat", base], opts(ctx));
  if (r.code !== 0) return { added: 0, removed: 0 };
  const ins = /(\d+) insertion/.exec(r.stdout);
  const del = /(\d+) deletion/.exec(r.stdout);
  return { added: ins ? Number(ins[1]) : 0, removed: del ? Number(del[1]) : 0 };
}

/** `git log -n <count>` one-line block for a ref (the inner-prompt recent
 * commits block). Best-effort: empty string when the ref/log is unavailable. */
export async function recentCommits(ctx: GitContext, ref = "main", count = 5): Promise<string> {
  const r = await git(["log", "-n", String(count), "--oneline", ref], opts(ctx));
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * Add a detached worktree for `branch` under `path` (fetching origin first so a
 * sandcastle-pushed worker branch is visible locally). Returns true on success.
 * Best-effort cleanup is the caller's via {@link worktreeRemove}.
 */
export async function worktreeAdd(ctx: GitContext, path: string, branch: string): Promise<boolean> {
  await git(["fetch", "origin", branch], opts(ctx));
  // Prefer the local branch if it exists, else the fetched origin ref.
  const local = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], opts(ctx));
  const ref = local.code === 0 ? branch : `origin/${branch}`;
  const r = await git(["worktree", "add", "--force", "--detach", path, ref], opts(ctx));
  return r.code === 0;
}

/** Remove a worktree previously added by {@link worktreeAdd} (best-effort). */
export async function worktreeRemove(ctx: GitContext, path: string): Promise<void> {
  if (!path) return;
  await git(["worktree", "remove", "--force", path], opts(ctx));
}

/** The GitExec executor for remote-branch.ts (pushAttempt / deleteRemote). */
export function gitExec(ctx: GitContext): GitExec {
  return async (args: string[]): Promise<GitExecResult> => {
    const r = await git(args, opts(ctx));
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

/** The merge.ts Exec executor (integrateOrigin / landMerge / landPr). */
export function mergeExec(ctx: GitContext): MergeExec {
  return async (args: string[]): Promise<MergeExecResult> => {
    // merge.ts passes a full argv whose head is "git" or "gh".
    const [head, ...rest] = args;
    const { execTool } = await import("./exec.js");
    const r = await execTool(head ?? "git", rest, opts(ctx));
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
}

// ---------- branch listing for the reap command ----------

/** List local branches matching a glob (e.g. "afk/*"), as bare ref names. */
export async function listLocalBranches(ctx: GitContext, pattern: string): Promise<string[]> {
  const r = await git(["branch", "--list", pattern, "--format=%(refname:short)"], opts(ctx));
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Local branches currently checked out (to exclude from the local reaper). */
export async function checkedOutBranches(ctx: GitContext): Promise<Set<string>> {
  const out = new Set<string>();
  const r = await git(["worktree", "list", "--porcelain"], opts(ctx));
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
  const r = await git(["ls-remote", "--heads", "origin", `refs/heads/${namespace}*`], opts(ctx));
  if (r.code !== 0) return [];
  const refs: BranchRef[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /\trefs\/heads\/(.+)$/.exec(line);
    if (m && m[1]) refs.push({ branch: m[1] });
  }
  return refs;
}
