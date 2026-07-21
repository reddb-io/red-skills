// mcp-sensitive-adapter.ts — the dev:afk MCP's sensitive engine-op deps.
//
// The Gate, Landing, Claim, and Worktree domains all reach primitives that RUN
// the repo's own commands, merge into the trunk, or mutate coordination state,
// so they live apart from the read-mostly Fleet/Observability wiring in
// mcp-adapter.ts. Every dep here wraps a value-returning primitive — never the
// print-and-exit command layer — and returns a plain structured object the MCP
// server encodes as TOON.

import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type {
  ClaimIssueInput,
  ClaimReleaseInput,
  GateRunInput,
  LandBranchInput,
  WorktreeRemoveInput,
} from "../../../packages/red-castle/src/mcp-server.js";
import {
  classifyIssueClaims,
  makeStaleClaimPredicate,
} from "./core/claim-staleness.js";
import { parseClaimRecords, renderClaimComment } from "./core/claim.js";
import { getConfig, loadConfig, readValidationResourceBudget } from "./core/config.js";
import { relevantScopes, runFeedback } from "./core/feedback.js";
import { doLanding, landingMergeTitle } from "./core/landing.js";
import { mainRedRepairFailuresFromBody } from "./core/main-red-repair.js";
import * as ghx from "./runtime/gh.js";
import * as gitx from "./runtime/git.js";
import { makeFeedbackWorktree } from "./runtime/feedback-worktree.js";
import { isLocked, readLockedBranch } from "./runtime/lock.js";
import { afkPaths, resolveRepoContext } from "./runtime/wire.js";

/** The disposable worktree lanes (ADR 0098) `worktree_list`/`worktree_remove` own. */
const WORKTREE_LANES = [
  "manual",
  "feedback",
  "landing",
  "rebase",
  "cascade",
  "adopt",
  "docs",
  "reconcile",
] as const;

function worktreesRoot(root: string): string {
  return join(root, ".red", "tmp", "worktrees");
}

function isUnder(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`${sep}`) && !rel.startsWith("/");
}

/** Base resolution shared by the gate and the landing: lock > config trunk > main. */
async function resolveTargetBase(root: string, requested?: string): Promise<string> {
  if (requested) return requested;
  const paths = afkPaths(root);
  const locked = await readLockedBranch(paths.branchLockPath);
  if (locked) return locked;
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  return getConfig(config, "dev.trunk") || "main";
}

async function gateRun(root: string, input: GateRunInput) {
  const paths = afkPaths(root);
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const gitCtx: gitx.GitContext = { cwd: root };
  const base = await resolveTargetBase(root, input.base);
  const feedback = makeFeedbackWorktree(root, paths.feedbackWorktreesDir, undefined, {
    resourceBudget: readValidationResourceBudget(config),
  });
  try {
    const changedFiles = await gitx.changedFiles(gitCtx, input.branch, base);
    const scopes = relevantScopes(feedback.layout, changedFiles);
    const result = await runFeedback(feedback.pnpm, {
      worktree: input.branch,
      scopes,
      layout: feedback.layout,
      now: () => Date.now(),
      baselineWorktree: base,
      resourceBudget: readValidationResourceBudget(config),
    });
    return {
      branch: input.branch,
      base,
      scopes,
      changed_files: changedFiles.length,
      ok: result.ok,
      checks: result.checks.map((check) => ({
        name: check.name,
        script: check.script,
        scope: check.scope,
        status: check.status,
      })),
      baseline_probe_ran: result.baselineProbeRan === true,
      baseline_downgraded: result.baselineDowngraded,
      baseline_failures: result.baselineFailures ?? [],
    };
  } finally {
    await feedback.cleanup().catch(() => undefined);
  }
}

async function gateBaselineStatus(root: string) {
  const context = await resolveRepoContext(root);
  const issue = await ghx.findMainRedRepairIssue({ cwd: root, repo: context.repo });
  return {
    main_red: issue !== null,
    repair_issue: issue ? { number: issue.number, title: issue.title } : null,
    failures: issue ? mainRedRepairFailuresFromBody(issue.body) : [],
  };
}

async function landBranch(root: string, input: LandBranchInput) {
  const paths = afkPaths(root);
  const config = loadConfig(paths.configPath, { warn: () => undefined });
  const context = await resolveRepoContext(root);
  const gitCtx: gitx.GitContext = { cwd: root };
  const base = await resolveTargetBase(root, input.base);
  const trunk = getConfig(config, "dev.trunk") || "main";
  const issueData = await ghx.viewIssueFull({ cwd: root, repo: context.repo }, input.issue);
  if (!issueData) throw new Error(`issue #${input.issue} could not be read`);
  const changedFiles = await gitx.changedFiles(gitCtx, input.branch, base);
  const worktreeSlug = (value: string): string =>
    value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "branch";

  const result = await doLanding(
    {
      mergeExec: gitx.mergeExec(gitCtx),
      remoteGit: gitx.gitExec(gitCtx),
      fireHook: async () => true,
      makeLandingWorktree: async (target) => {
        const dest = join(paths.landingWorktreesDir, `${worktreeSlug(target)}-mcp-${input.issue}`);
        await gitx.worktreeRemove(gitCtx, dest);
        return (await gitx.worktreeAdd(gitCtx, dest, target)) ? dest : null;
      },
      removeLandingWorktree: (dir) => gitx.worktreeRemove(gitCtx, dir),
      makeRebaseWorktree: async (branch) => {
        const dest = join(paths.rebaseWorktreesDir, `${worktreeSlug(branch)}-mcp-${input.issue}`);
        await gitx.worktreeRemove(gitCtx, dest);
        return (await gitx.worktreeAdd(gitCtx, dest, branch)) ? dest : null;
      },
      removeRebaseWorktree: (dir) => gitx.worktreeRemove(gitCtx, dir),
      getDiffPaths: async () => ({
        changedFiles,
        packageJsonDiff: "",
      }),
      findMainRedRepairIssue: () =>
        ghx.findMainRedRepairIssue({ cwd: root, repo: context.repo }),
    },
    {
      openPr: input.openPr !== false,
      locked: await isLocked(paths.branchLockPath),
      repo: context.repo,
      repoDir: root,
      remote: "origin",
      branch: input.branch,
      base,
      trunk,
      issue: input.issue,
      title: issueData.title,
      labels: issueData.labels,
      changedFiles,
      ...(input.sensitivePathApproved ? { sensitivePathApproved: true } : {}),
    },
    {
      preMerge: () => `mcp land_branch #${input.issue} ${input.branch} -> ${base}`,
      postMerge: (mergeSha) =>
        `mcp land_branch #${input.issue} merged ${mergeSha ?? "(no sha)"} into ${base}`,
    },
  );

  return {
    issue: input.issue,
    branch: input.branch,
    base,
    merge_title: landingMergeTitle({
      issue: input.issue,
      title: issueData.title,
      labels: issueData.labels,
      changedFiles,
    }),
    ...result,
  };
}

const AFK_BRANCH_RE = /^afk\/([^/]+)\/(\d+)-/;

async function cascadeStatus(root: string) {
  const gitCtx: gitx.GitContext = { cwd: root };
  const trunk = await resolveTargetBase(root);
  const trunkTip = await gitx.resolveRef(gitCtx, `origin/${trunk}`);
  const refs = await gitx.listRemoteBranches(gitCtx, "afk/");
  const branches = [];
  for (const ref of refs) {
    const match = AFK_BRANCH_RE.exec(ref.branch);
    const onTrunkTip = trunkTip
      ? await gitx.isAncestor(gitCtx, trunkTip, `origin/${ref.branch}`)
      : undefined;
    branches.push({
      branch: ref.branch,
      worker: match?.[1] ?? "",
      issue: match ? Number(match[2]) : 0,
      last_commit_s: ref.commitS ?? 0,
      // undefined => the object is not local, so "needs a rebase" is unknown.
      needs_rebase: onTrunkTip === undefined ? "unknown" : String(!onTrunkTip),
    });
  }
  return {
    trunk,
    trunk_tip: trunkTip ?? "",
    branches,
    worktrees: await listLaneWorktrees(root, ["cascade"]),
  };
}

async function claimStatus(root: string, input: ClaimIssueInput) {
  const context = await resolveRepoContext(root);
  const comments = await ghx.listClaimComments(
    { cwd: root, repo: context.repo },
    input.issue,
  );
  const records = parseClaimRecords(comments);
  const state = classifyIssueClaims(
    records,
    makeStaleClaimPredicate(Math.floor(Date.now() / 1_000)),
  );
  return {
    issue: input.issue,
    live_owner: state.liveOwner,
    stale_owners: state.staleOwners,
    conceded_owners: state.concededOwners,
    records: records.map((record) => ({
      comment_id: record.commentId,
      worker: record.worker,
      kind: record.kind,
      runner: record.runner ?? "",
      created_at: record.createdAt ?? "",
    })),
  };
}

async function claimRelease(root: string, input: ClaimReleaseInput) {
  const context = await resolveRepoContext(root);
  const ghCtx = { cwd: root, repo: context.repo };
  const commentId = await ghx.postClaimComment(
    ghCtx,
    input.issue,
    renderClaimComment(
      { worker: input.worker, createdAt: new Date().toISOString() },
      "concede",
    ),
  );
  const state = classifyIssueClaims(
    parseClaimRecords(await ghx.listClaimComments(ghCtx, input.issue)),
    makeStaleClaimPredicate(Math.floor(Date.now() / 1_000)),
  );
  return {
    issue: input.issue,
    worker: input.worker,
    status: "conceded",
    comment_id: commentId,
    live_owner: state.liveOwner,
  };
}

/** Enumerate the on-disk dirs of the requested lanes, joined to their git state. */
async function listLaneWorktrees(root: string, lanes: readonly string[]) {
  const registered = new Map(
    (await gitx.listWorktrees({ cwd: root })).map((entry) => [resolve(entry.path), entry]),
  );
  const out = [];
  for (const lane of lanes) {
    const laneDir = join(worktreesRoot(root), lane);
    let entries: string[];
    try {
      entries = await readdir(laneDir);
    } catch {
      continue; // lane never used on this host
    }
    for (const name of entries.sort()) {
      const path = join(laneDir, name);
      const git = registered.get(resolve(path));
      out.push({
        lane,
        name,
        path: relative(root, path),
        registered: git !== undefined,
        branch: git?.branch ?? "",
        head: git?.head ?? "",
        detached: git?.detached === true,
      });
    }
  }
  return out;
}

async function worktreeList(root: string) {
  return {
    root: relative(root, worktreesRoot(root)),
    lanes: WORKTREE_LANES,
    worktrees: await listLaneWorktrees(root, WORKTREE_LANES),
  };
}

async function worktreeRemove(root: string, input: WorktreeRemoveInput) {
  const path = resolve(root, input.path);
  if (!isUnder(worktreesRoot(root), path)) {
    throw new Error("worktree_remove refuses a path outside .red/tmp/worktrees");
  }
  await gitx.worktreeRemove({ cwd: root }, path);
  return { path: relative(root, path), status: "removed" };
}

/** Build the Gate / Landing / Claim / Worktree deps for the dev:afk MCP server. */
export function createSensitiveMcpDependencies(root = process.cwd()) {
  return {
    gateRun: (input: GateRunInput) => gateRun(root, input),
    gateBaselineStatus: () => gateBaselineStatus(root),
    landBranch: (input: LandBranchInput) => landBranch(root, input),
    cascadeStatus: () => cascadeStatus(root),
    claimStatus: (input: ClaimIssueInput) => claimStatus(root, input),
    claimRelease: (input: ClaimReleaseInput) => claimRelease(root, input),
    worktreeList: () => worktreeList(root),
    worktreeRemove: (input: WorktreeRemoveInput) => worktreeRemove(root, input),
  };
}
