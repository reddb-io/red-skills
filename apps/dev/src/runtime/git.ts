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
import type { RemoteUrlFact } from "../core/operational-probes.js";
import { resolveGhQuotaBackoff, withGhQuotaBackoff, type GhQuotaBackoffOpts } from "./gh/quota.js";

export const FLEET_TRUNK = "red-trunk";
export const FLEET_TRUNK_REF = `refs/heads/${FLEET_TRUNK}`;

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
  /**
   * Overrides the quota-backoff options `gh`-headed commands routed through
   * {@link mergeExec} run with. ABSENT MEANS DEFAULT, NOT DISABLED (issue
   * #2800): rate-limit responses (REST 403/429, GraphQL RATE_LIMITED) always
   * retry with a bounded wait instead of returning failure immediately. onWait
   * emits 'quota-wait' activity so the wait is visible rather than reading as
   * silence. After the cap, the failing response is returned so the caller can
   * park with an explicit quota reason.
   */
  quotaBackoff?: GhQuotaBackoffOpts;
  /**
   * Optional ceiling for GitHub probes routed through mergeExec. Landing waits
   * also carry their own helper-level timeout for injected tests; this kills the
   * real `gh` child in production.
   */
  ghProbeTimeoutMs?: number;
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

interface PorcelainWorktree {
  path: string;
  head?: string;
  locked?: string;
}

export interface BrokenWorktreeQuarantine {
  path: string;
  reason: string;
  removed: boolean;
  error?: string;
}

function parseWorktreePorcelain(output: string): PorcelainWorktree[] {
  const worktrees: PorcelainWorktree[] = [];
  let current: PorcelainWorktree | undefined;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) worktrees.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (current && line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
    } else if (current && (line === "locked" || line.startsWith("locked "))) {
      current.locked = line.slice("locked".length).trim();
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

/**
 * Remove linked worktrees that can poison every repository-level git command.
 * Git leaves an `initializing` lock while `worktree add` is in flight; a killed
 * creator can strand that lock with a HEAD whose object was later collected.
 * `git worktree remove --force` refuses locked entries, so quarantine first
 * unlocks, then force-removes, and finally prunes the shared registry.
 *
 * The first porcelain entry is the primary checkout and is never eligible.
 * Healthy linked worktrees, including deliberately locked ones whose reason is
 * not `initializing`, are left untouched.
 */
export async function quarantineBrokenWorktrees(
  ctx: GitContext,
): Promise<BrokenWorktreeQuarantine[]> {
  const listed = await runGit(ctx, ["worktree", "list", "--porcelain"]);
  if (listed.code !== 0) return [];

  const quarantined: BrokenWorktreeQuarantine[] = [];
  const linked = parseWorktreePorcelain(listed.stdout).slice(1);
  for (const worktree of linked) {
    const initializing = worktree.locked === "initializing";
    const head = worktree.head;
    const headExists = head
      ? (await runGit(ctx, ["cat-file", "-e", `${head}^{commit}`])).code === 0
      : false;
    if (!initializing && headExists) continue;

    const reasons = [initializing ? "initializing-lock" : "", !headExists ? "dangling-head" : ""]
      .filter(Boolean)
      .join(",");
    await runGit(ctx, ["worktree", "unlock", worktree.path]);
    const removed = await runGit(ctx, ["worktree", "remove", "--force", worktree.path]);
    quarantined.push({
      path: worktree.path,
      reason: reasons,
      removed: removed.code === 0,
      ...(removed.code === 0
        ? {}
        : { error: removed.stderr.trim() || `git worktree remove exited ${removed.code}` }),
    });
  }

  if (quarantined.length > 0) await runGit(ctx, ["worktree", "prune"]);
  return quarantined;
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

/** Named remote URLs from `git remote -v`, deduped by name+URL. */
export async function remoteUrlFacts(ctx: GitContext): Promise<RemoteUrlFact[]> {
  const r = await runGit(ctx, ["remote", "-v"]);
  if (r.code !== 0) return [];
  const seen = new Set<string>();
  const remotes: RemoteUrlFact[] = [];
  for (const line of r.stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    const name = parts[0];
    const url = parts[1];
    if (!name || !url) continue;
    const key = `${name}\0${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    remotes.push({ name, url });
  }
  return remotes;
}

export async function setRemoteUrl(ctx: GitContext, name: string, url: string): Promise<void> {
  const r = await runGit(ctx, ["remote", "set-url", name, url]);
  if (r.code !== 0) throw new Error(`git remote set-url failed for ${name}`);
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

/** `git -C cwd rev-parse --verify --quiet HEAD`, full sha. */
export async function headSha(ctx: GitContext): Promise<string | undefined> {
  const r = await runGit(ctx, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : undefined;
}

export type DeleteLocalBranchResult = { ok: true } | { ok: false; error: string };

/** Delete a local branch (git branch -D), returning a best-effort cleanup result. */
export async function deleteLocalBranch(ctx: GitContext, branch: string): Promise<DeleteLocalBranchResult> {
  if (!branch) return { ok: true };
  const result = await runGit(ctx, ["branch", "-D", branch]);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    return { ok: false, error: `git branch -D failed for ${branch}: ${detail}` };
  }
  return { ok: true };
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

export interface LocalRemoteDivergence {
  readonly localSha?: string;
  readonly remoteSha?: string;
  readonly ahead?: number;
  readonly behind?: number;
  readonly remoteReachable: boolean;
}

export async function localRemoteDivergence(
  ctx: GitContext,
  input: { remote: string; branch: string },
): Promise<LocalRemoteDivergence> {
  const remote = input.remote.trim() || "origin";
  const branch = input.branch.trim();
  if (!branch) return { remoteReachable: false };
  const fetch = await runGit(ctx, ["fetch", "--quiet", remote, branch]);
  const localSha = await revParse(ctx, `refs/heads/${branch}`);
  const remoteSha = await revParse(ctx, `${remote}/${branch}`);
  const counts = localSha && remoteSha
    ? await localAheadBehind(ctx, `refs/heads/${branch}`, `${remote}/${branch}`)
    : undefined;
  return {
    localSha,
    remoteSha,
    ahead: counts?.ahead,
    behind: counts?.behind,
    remoteReachable: fetch.code === 0,
  };
}

/** Best-effort `git fetch origin <branch>` (FIX E recovery: try once to pull a
 * sandcastle-pushed worker branch onto the host before declaring it absent). */
export async function fetchBranch(ctx: GitContext, branch: string): Promise<void> {
  if (!branch) return;
  await runGit(ctx, ["fetch", "origin", branch]);
}

export interface ResolveFreshBaseInput {
  base: string;
  remote?: string;
}

export interface FreshBaseResolution {
  ok: boolean;
  base: string;
  baseRef: string;
  sha: string;
  source: "remote" | "local" | "mirror";
  remoteReachable: boolean;
  localSha?: string;
  localAhead?: number;
  localBehind?: number;
  reason?: "base-stale";
  message?: string;
}

async function revParse(ctx: GitContext, ref: string): Promise<string | undefined> {
  const r = await runGit(ctx, ["rev-parse", "--verify", "--quiet", ref]);
  const sha = r.stdout.trim();
  return r.code === 0 && sha !== "" ? sha : undefined;
}

async function localAheadBehind(
  ctx: GitContext,
  localRef: string,
  remoteRef: string,
): Promise<{ ahead: number; behind: number } | undefined> {
  const r = await runGit(ctx, ["rev-list", "--left-right", "--count", `${localRef}...${remoteRef}`]);
  if (r.code !== 0) return undefined;
  const [aheadRaw, behindRaw] = r.stdout.trim().split(/\s+/);
  const ahead = Number(aheadRaw);
  const behind = Number(behindRaw);
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return undefined;
  return { ahead, behind };
}

/**
 * Resolve the concrete commit a new AFK worker should branch from.
 *
 * Online: fetch `<remote> <base>`, advance the fleet-owned `red-trunk` mirror
 * ref to that tip, and fork workers from the mirror. The mirror is never checked
 * out or committed to directly; it is just an owned ref updated with
 * `git update-ref`. If upstream history was rewritten, the mirror is reset to
 * the fetched remote tip because it holds no unique commits.
 *
 * Offline or unresolvable remote: return a typed `base-stale` park decision
 * instead of falling back to the primary checkout's local branch.
 */
export async function resolveFreshBase(
  ctx: GitContext,
  input: ResolveFreshBaseInput,
): Promise<FreshBaseResolution> {
  const base = input.base.trim();
  const remote = input.remote?.trim() || "origin";
  const remoteRef = `${remote}/${base}`;
  const fetch = base ? await runGit(ctx, ["fetch", remote, base]) : failOutput("empty base");
  const remoteSha = base ? await revParse(ctx, remoteRef) : undefined;

  if (fetch.code === 0 && remoteSha) {
    const mirrorSha = await revParse(ctx, FLEET_TRUNK_REF);
    if (mirrorSha && mirrorSha !== remoteSha) {
      await runGit(ctx, ["merge-base", "--is-ancestor", FLEET_TRUNK_REF, remoteRef]);
    }
    const updated = await runGit(ctx, ["update-ref", FLEET_TRUNK_REF, remoteSha]);
    if (updated.code !== 0) {
      const detail = updated.stderr.trim() || `git update-ref exited ${updated.code}`;
      return {
        ok: false,
        base,
        baseRef: remoteRef,
        sha: remoteSha,
        source: "mirror",
        remoteReachable: true,
        reason: "base-stale",
        message: `could not update fleet trunk mirror ${FLEET_TRUNK} from ${remoteRef}: ${detail}`,
      };
    }
    return {
      ok: true,
      base,
      baseRef: FLEET_TRUNK,
      sha: remoteSha,
      source: "mirror",
      remoteReachable: true,
    };
  }

  const detail = fetch.code !== 0
    ? fetch.stderr.trim() || `git fetch exited ${fetch.code}`
    : `${remoteRef} did not resolve after fetch`;

  return {
    ok: false,
    base,
    baseRef: remoteRef,
    sha: remoteSha ?? "",
    source: "mirror",
    remoteReachable: false,
    reason: "base-stale",
    message: `could not refresh fleet trunk mirror ${FLEET_TRUNK} from ${remoteRef}: ${detail}`,
  };
}

function failOutput(stderr: string): ExecOutput {
  return { code: 1, stdout: "", stderr };
}

export interface FreshWorkerBranchInput {
  branch: string;
  baseRef: string;
  remote?: string;
  force?: boolean;
}

/**
 * Remove stale sandcastle worker-branch state before a retry enters `runAgent`.
 *
 * red-castle's named-branch collision path reuses an existing managed worktree
 * and only fast-forwards it from `origin/<branch>`; it does not re-parent that
 * branch onto a freshly-fetched `origin/<base>`. For a merge-conflict retry, or
 * any branch whose merge-base with `baseRef` is not the current base tip, AFK
 * must clear the local worktree + refs so red-castle's `baseBranch` creation path
 * is used again. The prior diff is preserved by the attempt snapshot ref, not by
 * the live retry branch.
 */
export async function prepareFreshWorkerBranch(
  ctx: GitContext,
  input: FreshWorkerBranchInput,
): Promise<boolean> {
  const branch = input.branch.trim();
  const baseRef = input.baseRef.trim();
  const remote = input.remote?.trim() || "origin";
  if (!branch || !baseRef) return false;

  const base = await runGit(ctx, ["rev-parse", "--verify", "--quiet", baseRef]);
  const baseTip = base.code === 0 ? base.stdout.trim() : "";
  if (!baseTip) return false;

  const worktreePath = await worktreePathForBranch(ctx, branch);
  const localBranchExists = await branchExists(ctx, branch);
  const remoteTrackingRef = `refs/remotes/${remote}/${branch}`;
  const remoteTracking = await runGit(ctx, ["rev-parse", "--verify", "--quiet", remoteTrackingRef]);
  const remoteTrackingExists = remoteTracking.code === 0 && remoteTracking.stdout.trim() !== "";

  const compareRef = localBranchExists ? branch : remoteTrackingExists ? `${remote}/${branch}` : undefined;
  let stale = false;
  if (compareRef) {
    const mergeBase = await runGit(ctx, ["merge-base", compareRef, baseRef]);
    stale = mergeBase.code !== 0 || mergeBase.stdout.trim() !== baseTip;
  }

  const hasReusableState = Boolean(worktreePath || localBranchExists || remoteTrackingExists);
  const shouldClean = input.force ? hasReusableState : stale;
  if (!shouldClean) return false;

  if (worktreePath) await worktreeRemove(ctx, worktreePath);
  if (localBranchExists) await deleteLocalBranch(ctx, branch);
  if (remoteTrackingExists) await runGit(ctx, ["update-ref", "-d", remoteTrackingRef]);
  await runGit(ctx, ["push", remote, "--delete", branch]);
  return true;
}

/**
 * Has the worker branch ALREADY landed in `<base>`? — the own-merge signal for
 * the goal predicate (ADR 0057). When the goal-predicate poll observes the claimed
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

/**
 * The worktree diff of <branch> against the merge base (git diff base...branch).
 *
 * This is what the gate fold's review stage reads (#2730): the stage runs BEFORE
 * a pull request exists, so `gh pr diff` has nothing to answer with. A failing
 * git call yields the empty string, which the caller reads as "no diff to
 * review" and skips the stage rather than reviewing nothing.
 */
export async function worktreeDiff(ctx: GitContext, branch: string, base: string): Promise<string> {
  const r = await runGit(ctx, ["diff", `${base}...${branch}`]);
  return r.code === 0 ? r.stdout : "";
}

/** How many base commits to name when reporting stale-base drift. Enough to
 * recognise a release bump plus its neighbours; more would just bloat the
 * handoff a correction cycle carries. */
const BASE_MOVEMENT_SUBJECT_LIMIT = 20;

/**
 * What `<baseRef>` did since `<sinceSha>` (issue #2711): its head sha now, plus
 * the subjects of the commits it gained, oldest → newest. Best-effort — an
 * unresolvable ref or a failing log yields the sha it could read and an empty
 * subject list, so the caller falls back to charging the failure to the branch
 * rather than inventing base movement it cannot see.
 */
export async function baseMovementSince(
  ctx: GitContext,
  baseRef: string,
  sinceSha: string,
): Promise<{ head: string; subjects: string[] }> {
  const head = (baseRef ? await revParse(ctx, baseRef) : undefined) ?? "";
  if (!head || !sinceSha || head === sinceSha) return { head, subjects: [] };
  const r = await runGit(ctx, [
    "log",
    "--reverse",
    "--format=%s",
    `--max-count=${BASE_MOVEMENT_SUBJECT_LIMIT}`,
    `${sinceSha}..${head}`,
  ]);
  if (r.code !== 0) return { head, subjects: [] };
  return { head, subjects: r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) };
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
  return parseShortstat(r.code === 0 ? r.stdout : "");
}

/** Extract the `N insertion` / `N deletion` integers from a `--shortstat` line,
 * defaulting each to 0 when absent. Shared by the committed/uncommitted probes. */
function parseShortstat(stdout: string): { added: number; removed: number } {
  const ins = /(\d+) insertion/.exec(stdout);
  const del = /(\d+) deletion/.exec(stdout);
  return { added: ins ? Number(ins[1]) : 0, removed: del ? Number(del[1]) : 0 };
}

/**
 * Parsed diffstat of the attempt's **committed** work at `ctx.cwd` — the commits
 * on the branch since it left `<base>`, EXCLUDING the working tree. Resolves
 * `merge-base(<base>, HEAD)` and diffs that against HEAD (`git diff --shortstat
 * <merge-base>..HEAD`), falling back to a plain `<base>..HEAD` when no merge-base
 * resolves. This is the sha-memoizable half of the #1224 LOC counter: while HEAD
 * is unchanged the committed volume is stable, so it is computed at most once per
 * commit and the render path stays git-free.
 */
export async function diffstatCommitted(ctx: GitContext, base: string): Promise<{ added: number; removed: number }> {
  let ref = base;
  const mb = await runGit(ctx, ["merge-base", base, "HEAD"]);
  if (mb.code === 0 && mb.stdout.trim() !== "") ref = mb.stdout.trim();
  const r = await runGit(ctx, ["diff", "--shortstat", `${ref}..HEAD`]);
  return parseShortstat(r.code === 0 ? r.stdout : "");
}

/**
 * Parsed diffstat of the attempt's **uncommitted** working-tree edits at
 * `ctx.cwd` — everything not yet committed (`git diff --shortstat HEAD`). This is
 * the NON-memoizable half of the #1224 LOC counter: a codex worker never commits,
 * so its HEAD sha is frozen and only this working-tree delta reflects its work.
 * The writer recomputes it on every heartbeat tick and adds it to the memoized
 * committed volume, so total attempt LOC surfaces even with zero commits.
 */
export async function diffstatUncommitted(ctx: GitContext): Promise<{ added: number; removed: number }> {
  const r = await runGit(ctx, ["diff", "--shortstat", "HEAD"]);
  return parseShortstat(r.code === 0 ? r.stdout : "");
}

/** `git log -n <count>` one-line block for a ref (the inner-prompt recent
 * commits block). Best-effort: empty string when the ref/log is unavailable. */
export async function recentCommits(ctx: GitContext, ref = "main", count = 5): Promise<string> {
  const r = await runGit(ctx, ["log", "-n", String(count), "--oneline", ref]);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * Outcome of {@link worktreeAdd}. `stderr` carries the UNDERLYING git failure
 * (fetch and/or `worktree add`) so a caller's error line names the real cause
 * (#2339). A bare boolean forced every field report to guess why the gate's
 * worktree never materialised — keep the detail attached to the failure.
 */
export interface WorktreeAddResult {
  ok: boolean;
  /** Combined git stderr, trimmed. Empty when git said nothing. */
  stderr: string;
}

/**
 * Add a detached worktree for `branch` under `path` (fetching origin first so a
 * sandcastle-pushed worker branch is visible locally). Returns `{ ok: true }` on
 * success and `{ ok: false, stderr }` with the real git stderr otherwise.
 * Best-effort cleanup is the caller's via {@link worktreeRemove}.
 */
export async function worktreeAdd(
  ctx: GitContext,
  path: string,
  branch: string,
): Promise<WorktreeAddResult> {
  const fetched = await runGit(ctx, ["fetch", "origin", branch]);
  // Always use the freshly-fetched origin tip so validation never runs against
  // a stale local ref that diverges from what was pushed.
  const r = await runGit(ctx, ["worktree", "add", "--force", "--detach", path, `origin/${branch}`]);
  if (r.code === 0) return { ok: true, stderr: "" };
  // A failed fetch is usually the ROOT cause (the ref does not exist, e.g. a
  // filesystem path passed where a branch belongs), and the `worktree add` that
  // follows only reports the missing `origin/<branch>` — carry both.
  const stderr = [fetched.code === 0 ? "" : fetched.stderr, r.stderr]
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
  return { ok: false, stderr };
}

/**
 * Emit the one diagnostic line a failed {@link worktreeAdd} owes the operator
 * (#2339): dest, the ref we tried to check out, and the REAL git stderr. Every
 * landing/rebase provisioner collapses the failure to `null`, so without this
 * the only field evidence was a silent refusal.
 */
export function warnWorktreeAdd(dest: string, branch: string, stderr: string): void {
  process.stderr.write(
    `error: worktree add failed for ${branch} at ${dest}: ${stderr || "no git detail"}\n`,
  );
}

/** Remove a worktree previously added by {@link worktreeAdd} (best-effort). */
export async function worktreeRemove(ctx: GitContext, path: string): Promise<void> {
  if (!path) return;
  await runGit(ctx, ["worktree", "remove", "--force", path]);
}

/**
 * Run `git worktree prune` to drop stale entries from git's internal worktree
 * registry after orphaned worktree dirs have been removed from disk. Best-effort:
 * never throws so a prune failure does not abort the janitor sweep.
 */
export async function worktreePrune(ctx: GitContext): Promise<void> {
  await runGit(ctx, ["worktree", "prune"]);
}

/** The GitExec executor for remote-branch.ts live-branch push/delete helpers. */
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
    const commandOpts = head === "gh" && ctx.ghProbeTimeoutMs
      ? { ...opts(ctx), timeoutMs: ctx.ghProbeTimeoutMs }
      : opts(ctx);
    const fn = (): Promise<ExecOutput> => exec(head ?? "git", rest, commandOpts);
    // Apply quota backoff only to `gh`-headed commands: git commands do not
    // make GitHub API calls and must never be silently delayed. For `gh`, an
    // absent ctx.quotaBackoff resolves to the DEFAULT options, never to no
    // backoff — the landing path is exactly where a rate limit used to look
    // like a merge failure (#2800).
    const r = head === "gh"
      ? await withGhQuotaBackoff(fn, resolveGhQuotaBackoff(ctx.quotaBackoff))
      : await fn();
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
 * the branch. Used to reach the worktree an inner agent is editing (for example
 * to resolve its host settings) without assuming the attempt-dir layout.
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
 * Resolve the conventional worktree registered at `{dirPrefix}/worktree`,
 * parsed from `git worktree list --porcelain`. Nested castle-branded paths are
 * intentionally excluded from this normal reader; hygiene owns their rollout
 * compatibility. Returns undefined when the worktree is not registered yet.
 */
export async function worktreePathUnder(ctx: GitContext, dirPrefix: string): Promise<string | undefined> {
  const r = await runGit(ctx, ["worktree", "list", "--porcelain"]);
  if (r.code !== 0) return undefined;
  const prefix = dirPrefix.replace(/\/+$/, "");
  const expected = `${prefix}/worktree`;
  for (const line of r.stdout.split("\n")) {
    const w = /^worktree\s+(.+)$/.exec(line.trim());
    if (w?.[1] === expected) return w[1];
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
 * List origin refs under a namespace (for example "afk/") via ls-remote,
 * shaped as BranchRef[]. Best-effort fills the last-commit epoch when the commit
 * object is present locally; callers that need it must degrade safely when it is
 * absent.
 */
export async function listRemoteBranches(ctx: GitContext, namespace: string): Promise<BranchRef[]> {
  const r = await runGit(ctx, ["ls-remote", "--heads", "origin", `refs/heads/${namespace}*`]);
  if (r.code !== 0) return [];
  const refs: BranchRef[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^([0-9a-fA-F]+)\trefs\/heads\/(.+)$/.exec(line);
    if (!m || !m[1] || !m[2]) continue;
    const ref: BranchRef = { branch: m[2] };
    const commitS = await remoteCommitEpoch(ctx, m[1], m[2]);
    if (commitS !== undefined) ref.commitS = commitS;
    refs.push(ref);
  }
  return refs;
}

async function remoteCommitEpoch(ctx: GitContext, sha: string, branch: string): Promise<number | undefined> {
  const read = async (): Promise<number | undefined> => {
    const ts = await runGit(ctx, ["show", "-s", "--format=%ct", sha]);
    const commitS = Number((ts.stdout ?? "").trim());
    return ts.code === 0 && Number.isFinite(commitS) ? commitS : undefined;
  };
  const local = await read();
  if (local !== undefined) return local;
  await runGit(ctx, ["fetch", "--quiet", "--no-tags", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  return read();
}
