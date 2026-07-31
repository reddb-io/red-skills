import { encode as encodeToon } from "@reddb-io/toon";

import { getConfig, loadConfig } from "../core/config.js";
import { DEFAULT_BRANCH } from "../core/pin-reader.js";
import type { AttemptPullRequest } from "../core/branch-resume.js";
import { remoteTrackingBaseRef } from "../core/process-issue/types.js";
import {
  issueFromBranchRef,
  listOrphanBranches,
  type OrphanBranchProbe,
} from "../core/orphan-branch.js";
import * as ghx from "../runtime/gh.js";
import * as gitx from "../runtime/git.js";
import { resolveRepoContext } from "../runtime/wire.js";

/** The three reads the report needs, injected so the whole surface is testable
 * without a repository or a forge. */
export interface OrphanBranchesDeps {
  /** The trunk's name, for the report. */
  trunk: string;
  /**
   * The ref every branch is counted against — the FRESH REMOTE trunk, never the
   * local branch (ADR 0083). A stale local `main` does not carry what already
   * landed, so every merged branch would read as commits ahead and the report
   * would name finished, landed work as orphaned.
   */
  baseRef: string;
  listBranches: () => Promise<Array<{ branch: string }>>;
  commitsAhead: (branch: string, base: string) => Promise<number | undefined>;
  openPullRequests: () => Promise<AttemptPullRequest[]>;
}

/**
 * Render the orphaned-work census as TOON and answer with an exit code: 0 when
 * nothing is stranded, 1 when the listing is non-empty, so the command is usable
 * as a check and not only as a report (#2893).
 */
export async function runOrphanBranchesReport(
  deps: OrphanBranchesDeps,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  const refs = await deps.listBranches();
  const branches: OrphanBranchProbe[] = [];
  for (const ref of refs) {
    if (issueFromBranchRef(ref.branch) === null) continue;
    branches.push({ branch: ref.branch, commitsAhead: await deps.commitsAhead(ref.branch, deps.baseRef) });
  }
  const orphans = listOrphanBranches({ branches, openPullRequests: await deps.openPullRequests() });

  stdout.write(
    `${encodeToon({
      report: "orphan-branches",
      trunk: deps.trunk,
      scanned: branches.length,
      orphaned: orphans.length,
      // `commits_ahead: -1` means the probe could not read the branch — listed
      // because unseen work is the defect, never collapsed to 0.
      branches: orphans.map((o) => ({
        branch: o.branch,
        issue: o.issue,
        commits_ahead: o.commitsAhead ?? -1,
      })),
    })}\n`,
  );
  return orphans.length > 0 ? 1 : 0;
}

/**
 * `orphan-branches` — the surface that answers "what finished work has no route
 * to the trunk?" without a human reading `git branch -r` by hand (#2893).
 *
 * Every remote `afk/*` ref is read for the commits it carries ahead of the trunk
 * and matched against the open-PR census; what survives is listed with its
 * branch, its issue and its commit count, so the recovery is one `gh pr create`
 * instead of an investigation. Read-only — it names branches, it never deletes
 * or opens anything.
 */
export async function orphanBranchesCommand(
  _args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
): Promise<number> {
  const ctx = await resolveRepoContext(cwd);
  const gitCtx: gitx.GitContext = { cwd: ctx.root };
  const ghCtx: ghx.GhContext = { cwd: ctx.root, repo: ctx.repo };
  const trunk = getConfig(await loadConfig(ctx.root), "dev.trunk") || DEFAULT_BRANCH;
  // The report is only as true as the base it counts against, so the trunk is
  // refreshed before anything is counted.
  await gitx.fetchBranch(gitCtx, trunk).catch(() => {});
  return runOrphanBranchesReport(
    {
      trunk,
      baseRef: remoteTrackingBaseRef(ctx.remote, trunk),
      listBranches: () => gitx.listRemoteBranches(gitCtx, "afk/"),
      commitsAhead: (branch, base) => gitx.branchCommitsAhead(gitCtx, branch, base),
      openPullRequests: () => ghx.listOpenPullRequests(ghCtx),
    },
    stdout,
  );
}
