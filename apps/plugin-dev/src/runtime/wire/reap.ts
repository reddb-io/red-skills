import type { BranchRef, IssueMeta } from "../../core/branch-cleanup.js";
import { liveIssueFromBranch } from "../../core/branch-cleanup.js";
import { getConfig, loadConfig } from "../../core/config.js";
import { DEFAULT_BRANCH } from "../../core/pin-reader.js";
import { issueMeta, listIssueStates, type GhContext } from "../gh.js";
import * as gitx from "../git.js";
import { type RepoContext } from "./paths.js";

export interface ReapInputs {
  remoteLiveRefs: BranchRef[];
  localLiveRefs: BranchRef[];
  /** Local branches the trunk already carries — the landed fact (#2866). */
  landedLocalBranches: string[];
  /** The repo's configured trunk, so the reclaim can spare it by name. */
  trunk: string;
  /** Synchronous issue-state lookup (pre-resolved gh metadata cache). */
  lookup: (issue: number) => IssueMeta | null | undefined;
  /** git deletion closures bound to the repo. */
  deleteRemote: (branch: string) => Promise<void>;
  deleteLocal: (branch: string) => Promise<void>;
}

/**
 * List the live branch namespaces and pre-resolve every referenced issue's gh
 * state into a synchronous cache (branch-cleanup's IssueLookup is sync). Local
 * checked-out branches are excluded from the local live set.
 */
export async function collectReapInputs(ctx: RepoContext): Promise<ReapInputs> {
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: GhContext = { cwd: ctx.root, repo: ctx.repo };

  const remoteLiveRefs = await gitx.listRemoteBranches(gitCtx, "afk/");
  const localAll = await gitx.listLocalBranches(gitCtx, "afk/*");
  const checkedOut = await gitx.checkedOutBranches(gitCtx);
  const localLiveRefs: BranchRef[] = localAll
    .filter((b) => !checkedOut.has(b))
    .map((b) => ({ branch: b }));
  const trunk = getConfig(await loadConfig(ctx.root), "dev.trunk") || DEFAULT_BRANCH;
  // Against the trunk's REMOTE ref: a stale local trunk under-reports what has
  // landed, and under-reporting only ever spares (#2866).
  const landedLocalBranches = await gitx.listMergedLocalBranches(
    gitCtx,
    "afk/*",
    `${ctx.remote}/${trunk}`,
  );

  // Pre-resolve every issue referenced across the live branch sets.
  const issues = new Set<number>();
  for (const r of [...remoteLiveRefs, ...localLiveRefs]) {
    const n = liveIssueFromBranch(r.branch);
    if (n !== null) issues.add(n);
  }
  // ONE batched issue-state fetch replaces the per-issue `gh issue view` storm.
  // A map miss (issue beyond the --limit window / just-created / transient list
  // failure) falls back to the live `issueMeta` so closedAt-grace stays exact.
  const states = await listIssueStates(ghCtx);
  const cache = new Map<number, IssueMeta | null | undefined>();
  for (const n of issues) {
    const row = states.get(n);
    if (row) cache.set(n, { state: row.state, closedAt: row.closedAt });
    else cache.set(n, await issueMeta(ghCtx, n));
  }

  return {
    remoteLiveRefs,
    localLiveRefs,
    landedLocalBranches,
    trunk,
    lookup: (issue) => cache.get(issue),
    deleteRemote: (branch) => gitx.deleteRemoteBranch(gitCtx, branch),
    deleteLocal: async (branch) => {
      await gitx.deleteLocalBranch(gitCtx, branch);
    },
  };
}
