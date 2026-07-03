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

/**
 * True when `<branch>` exists as a LOCAL ref (git rev-parse --verify --quiet
 * refs/heads/<branch>). FIX E: a three-dot `git diff base...branch` against a
 * NON-EXISTENT branch returns empty with code 0 — indistinguishable from "no
 * changes" — so the merge gate must first confirm the worker branch actually
 * reached the host before resolving feedback scopes from `changedFiles`.
 */
export async function branchExists(ctx: GitContext, branch: string): Promise<boolean> {
  if (!branch) return false;
  const r = await runGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.code === 0;
}

/**
 * The current commit sha of a LOCAL branch ref, or undefined when the branch
 * has no ref yet / git fails. The attempt progress guard (execution.ts) polls
 * this: the worker branch's HEAD advances on every inner-agent commit (the ref
 * lives in the shared `.git`, visible from any cwd in the repo), giving a clean
 * "is the agent producing work?" signal independent of liveness.
 */
export async function branchHead(ctx: GitContext, branch: string): Promise<string | undefined> {
  if (!branch) return undefined;
  const r = await runGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : undefined;
}

/** Best-effort `git fetch origin <branch>` (FIX E recovery: try once to pull a
 * sandcastle-pushed worker branch onto the host before declaring it absent). */
export async function fetchBranch(ctx: GitContext, branch: string): Promise<void> {
  if (!branch) return;
  await runGit(ctx, ["fetch", "origin", branch]);
}

/**
 * Has the worker branch ALREADY landed in `<base>`? — the own-merge signal for
 * the goal predicate (ADR 0057). When the attempt-guard poll observes the claimed
 * issue CLOSED, this distinguishes "the close carries THIS attempt's own merge"
 * (`done`) from "a foreign lander closed it" (`claim-lost`): true iff the worker
 * branch's tip commit is an ancestor of `origin/<base>` (i.e. its commits are
 * contained in the base — it was merged).
 *
 * The branch tip is resolved from the local ref first (sandcastle's worktree),
 * falling back to the continuous-push `origin/<branch>` copy. Best-effort and
 * safe-by-default: an unresolvable branch, a missing base ref, or any git failure
 * returns `false`, so the predicate never falsely claims credit (`done`) — it
 * degrades to `claim-lost`.
 */
export async function branchMergedInto(ctx: GitContext, branch: string, base: string): Promise<boolean> {
  if (!branch || !base) return false;
  let head = await branchHead(ctx, branch);
  if (!head) {
    const r = await runGit(ctx, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
    head = r.code === 0 && r.stdout.trim() !== "" ? r.stdout.trim() : undefined;
  }
  if (!head) return false;
  // `merge-base --is-ancestor A B` exits 0 when A is an ancestor of B, 1 when it
  // is not, and >1 on error (e.g. a bad ref). Only a clean 0 counts as merged.
  const r = await runGit(ctx, ["merge-base", "--is-ancestor", head, `origin/${base}`]);
  return r.code === 0;
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
 * Parsed diffstat of the attempt's work at `ctx.cwd` — **committed plus
 * uncommitted** — measured from where the branch left `<base>`.
 *
 * Resolves `merge-base(<base>, HEAD)` and diffs that against the working tree
 * (`git diff --shortstat <merge-base>`), so the count reflects every commit the
 * inner agent has made on the branch as well as any uncommitted edits. The
 * previous `git diff --shortstat <base>` only saw the *uncommitted* worktree, so
 * it collapsed to 0 the moment the agent committed — the monitor's "live but
 * empty diff" lie. Falls back to a plain `<base>` diff when no merge-base
 * resolves (e.g. an unborn branch). Extracts the `N insertion` / `N deletion`
 * integers, defaulting each to 0 when absent or on any failure.
 */
export async function diffstatShortstat(ctx: GitContext, base: string): Promise<{ added: number; removed: number }> {
  let ref = base;
  const mb = await runGit(ctx, ["merge-base", base, "HEAD"]);
  if (mb.code === 0 && mb.stdout.trim() !== "") ref = mb.stdout.trim();
  const r = await runGit(ctx, ["diff", "--shortstat", ref]);
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
  // Always use the freshly-fetched origin tip so validation never runs against
  // a stale local ref that diverges from what was pushed.
  const r = await runGit(ctx, ["worktree", "add", "--force", "--detach", path, `origin/${branch}`]);
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
 * Resolve the worktree path currently checked out on `branch`, parsed from
 * `git worktree list --porcelain`. Returns undefined when no live worktree holds
 * the branch. Used by {@link salvageUncommitted} to reach a worktree the inner
 * agent edited but never committed.
 */
export async function worktreePathForBranch(ctx: GitContext, branch: string): Promise<string | undefined> {
  const r = await runGit(ctx, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return undefined;
  let current: string | undefined;
  for (const line of r.stdout.split("\n")) {
    const w = /^worktree\s+(.+)$/.exec(line.trim());
    if (w && w[1]) {
      current = w[1];
      continue;
    }
    const b = /^branch\s+refs\/heads\/(.+)$/.exec(line.trim());
    if (b && b[1] === branch) return current;
  }
  return undefined;
}

/**
 * Resolve the worktree path registered under `dirPrefix` (the attempt dir),
 * parsed from `git worktree list --porcelain`. sandcastle creates the agent's
 * worktree at `{attemptDir}/.sandcastle/worktrees/{slug}`, but the state file's
 * `current.worktree` is seeded to the legacy `{attemptDir}/worktree` path that
 * never exists — so a `git diff` there fails and the heartbeat / monitor read a
 * permanent `+0 -0` even with a dirty worktree (the sandcastle-blind hazard). An
 * attempt has exactly one worktree, so the first match under `dirPrefix` is it.
 * Returns undefined when none is registered yet (pre-worktree ticks). Routed
 * through the same `runGit` seam so tests drive it without an OS git.
 */
export async function worktreePathUnder(ctx: GitContext, dirPrefix: string): Promise<string | undefined> {
  const r = await runGit(ctx, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return undefined;
  const prefix = dirPrefix.replace(/\/+$/, "");
  for (const line of r.stdout.split("\n")) {
    const w = /^worktree\s+(.+)$/.exec(line.trim());
    if (w && w[1] && (w[1] === prefix || w[1].startsWith(`${prefix}/`))) return w[1];
  }
  return undefined;
}

/**
 * Decode a single `git status --porcelain` path. When git deems a path "safe"
 * (only printable ASCII, no quote/control bytes) it emits it verbatim — returned
 * unchanged. Otherwise git wraps it in double quotes and C-style escapes the
 * payload (`core.quotePath` default): `\\`, `\"`, the named escapes
 * `\a \b \f \n \r \t \v`, and three-digit OCTAL escapes (`\303\251`) for each
 * raw byte of a non-ASCII / control character. We reverse that exactly: octal
 * runs are collected as bytes and UTF-8 decoded so a unicode filename round-trips
 * to the literal path `git add --` accepts. A path that isn't quote-wrapped is
 * passed through untouched.
 */
export function unquotePorcelainPath(raw: string): string {
  if (!(raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"'))) return raw;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  const named: Record<string, number> = {
    a: 0x07,
    b: 0x08,
    f: 0x0c,
    n: 0x0a,
    r: 0x0d,
    t: 0x09,
    v: 0x0b,
    '"': 0x22,
    "\\": 0x5c,
  };
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      // A non-escaped character — emit its UTF-8 bytes.
      for (const b of Buffer.from(ch, "utf8")) bytes.push(b);
      continue;
    }
    const next = body[i + 1] ?? "";
    if (next >= "0" && next <= "7") {
      // Octal escape: exactly up to three octal digits → one raw byte.
      let j = i + 1;
      let oct = "";
      while (j < body.length && oct.length < 3 && body[j] >= "0" && body[j] <= "7") {
        oct += body[j];
        j += 1;
      }
      bytes.push(parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    if (next in named) {
      bytes.push(named[next]);
      i += 1;
      continue;
    }
    // Unknown escape — keep the backslash literally (defensive; git won't emit
    // this) and let the following char be processed normally.
    bytes.push(0x5c);
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Salvage uncommitted work an inner agent left in its worktree. Observed with
 * the codex runner: the agent edits files, passes the gates, and emits
 * `<promise>DONE</promise>`, but leaves some or all paths dirty — so sandcastle
 * only sees the committed subset and the remaining diff is stranded.
 *
 * Locates the worktree checked out on `branch` and, when it is dirty, commits
 * each changed path on ITS OWN COMMIT — the one-commit-per-file discipline
 * AGENT-PROMPT mandates — then pushes the branch so the host ref carries the
 * work. Returns the number of files committed (0 = clean worktree / nothing to
 * salvage). Routed through the same `runGit` seam so tests drive it without an OS
 * git. Best-effort: a failing stage/commit on one path is skipped, never thrown.
 */
export async function salvageUncommitted(ctx: GitContext, branch: string, remote = "origin"): Promise<number> {
  const wt = await worktreePathForBranch(ctx, branch);
  if (!wt) return 0;
  const wctx: GitContext = { cwd: wt, exec: ctx.exec };
  const status = await runGit(wctx, ["status", "--porcelain"]);
  if (status.code !== 0) return 0;
  const paths: string[] = [];
  for (const line of status.stdout.split("\n")) {
    const t = line.replace(/\s+$/, "");
    if (!t) continue;
    // porcelain v1: "XY path" — the path begins at column 3. A rename is
    // "old -> new"; take the destination. Paths with special/non-ASCII bytes
    // are C-quoted by git (core.quotePath default), so they are unwrapped AND
    // un-escaped to the literal path `git add --` accepts — stripping the quotes
    // alone leaves backslash escapes that don't name the file, silently dropping
    // it from the salvage.
    let p = t.slice(3);
    const arrow = p.indexOf(" -> ");
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = unquotePorcelainPath(p);
    if (p) paths.push(p);
  }
  let committed = 0;
  for (const p of paths) {
    const add = await runGit(wctx, ["add", "--", p]);
    if (add.code !== 0) continue;
    const message = `afk: salvage uncommitted change to ${p}\n\nInner agent emitted a completion sentinel with this file still dirty; AFK committed it so the feedback gate and landing see the work.`;
    // `--no-verify` bypasses the CONSUMER repo's commit-phase hooks (pre-commit /
    // commit-msg) on AFK's own salvage commit (#840) — AFK's binding validation is
    // the feedback gate + backpressure, not the consumer's per-commit hooks, and a
    // reformat-and-restage hook would break the one-path-staged discipline. The
    // worktree's `core.hooksPath` redirect already covers the continuous-push path;
    // `--no-verify` covers the isolated-provider path where that hook never ran.
    // It leaves `post-commit` firing, so the continuous-push hook still pushes.
    const commit = await runGit(wctx, ["commit", "--no-verify", "-m", message, "--", p]);
    if (commit.code === 0) committed += 1;
  }
  if (committed > 0) {
    // The continuous-push post-commit hook may already have pushed each commit;
    // force-with-lease guarantees the host ref matches the salvaged worktree.
    await runGit(wctx, ["push", "--force-with-lease", remote, `HEAD:refs/heads/${branch}`]);
  }
  return committed;
}

/**
 * Push a LOCAL branch ref to `remote` (create or update the remote branch). The
 * ref lives in the shared `.git`, so this runs from the primary checkout cwd —
 * no worktree needed. Used by the ADR 0083 §4 exit barrier to guarantee the
 * attempt branch reached origin before the attempt is allowed to terminate.
 * Returns `{ok:true}` on a clean push; `{ok:false, error}` (never throws) on a
 * rejected/failed push so the barrier owns the retry + hard-error policy. Routed
 * through the same `runGit` seam so tests drive it without an OS git.
 */
export async function pushBranch(
  ctx: GitContext,
  branch: string,
  remote = "origin",
): Promise<{ ok: boolean; error?: string }> {
  if (!branch) return { ok: false, error: "empty branch" };
  const r = await runGit(ctx, ["push", remote, `refs/heads/${branch}:refs/heads/${branch}`]);
  if (r.code === 0) return { ok: true };
  return { ok: false, error: (r.stderr || r.stdout || `git push exited ${r.code}`).trim() };
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
