import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProcessIssueDeps } from "../../../core/process-issue.js";
import type { ConfigValues } from "../../../core/config.js";
import { getConfig } from "../../../core/config.js";
import * as ghx from "../../../runtime/gh.js";
import * as gitx from "../../../runtime/git.js";
import type { GhContext } from "../../../runtime/gh.js";
import type { GitContext } from "../../../runtime/git.js";
import { execTool, type ExecFn } from "../../../runtime/exec.js";
import type { AfkPaths } from "../../../runtime/wire.js";
import { branchLockPath, readLockedBranch, isLocked } from "../../../runtime/lock.js";
import { parseTrustPolicy, resolveActorTrust } from "../../../core/trust-gate.js";
import { buildHandoffEnrichment } from "../../../core/handoff-enrichment.js";
import { lookupPrevFailureContext } from "../../../core/prev-failure.js";

export interface LookupsPortContext {
  ghCtx: GhContext;
  gitCtx: GitContext;
  paths: AfkPaths;
  config: ConfigValues;
  exec?: ExecFn;
}

/**
 * Read-only lookup port — the ONE genuinely multi-context builder: base
 * resolution reads the lock file + config, the guidance channel reads gh, and
 * the branch/diff probes read git. Every other builder binds a single context.
 */
export function buildLookups({
  ghCtx,
  gitCtx,
  paths,
  config,
  exec,
}: LookupsPortContext): NonNullable<ProcessIssueDeps["lookups"]> {
  const root = ghCtx.cwd;
  const lockPath = branchLockPath(root);
  // Trust policy for the guidance-channel source-trust projection (issue #1100).
  const trustPolicy = parseTrustPolicy(config);

  return {
    base: {
      readLockedBranch: () => readLockedBranch(lockPath),
      configLockedBranch: getConfig(config, "dev.lock.branch") || undefined,
      configTrunk:
        (process.env.RED_AFK_TRUNK ?? "").trim() ||
        getConfig(config, "dev.trunk") ||
        undefined,
      fetchIssueBody: (n) => ghx.issueBody(ghCtx, n),
    },
    isLocked: () => isLocked(lockPath),
    // Source-trust classification for the guidance channel (issue #1100): each
    // comment's author is resolved through the `resolveActorTrust` primitive so
    // only a trusted-source directive can become authoritative `<human-guidance>`.
    comments: (issue) =>
      ghx.issueComments(ghCtx, issue, (actor) =>
        resolveActorTrust(trustPolicy, actor, (login) => ghx.actorTrustSignals(ghCtx, login)),
      ),
    issueUrl: (issue) => ghx.issueUrl(ghCtx, issue),
    // The ONE ADR 0103 carry-forward: on an automatic re-queue, surface the
    // previous failure reason + its Envelope reference in the next prompt.
    prevFailureContext: (issue) => lookupPrevFailureContext(paths.tmpDir, issue),
    handoffEnrichment: ({ issue: _issue, ...metadata }) =>
      buildHandoffEnrichment(metadata, {
        readText: (path) => readFile(join(root, path), "utf8"),
        gitLog: async (paths) => {
          if (paths.length === 0) return "";
          const run = exec ?? execTool;
          const result = await run(
            "git",
            ["log", "-n", "24", "--format=%H%x1f%s%x1f%b%x1e", "--", ...paths],
            { cwd: root, timeoutMs: 5_000, maxBuffer: 512 * 1024 },
          );
          return result.code === 0 ? result.stdout : "";
        },
      }),
    changedFiles: (branch, base) => gitx.changedFiles(gitCtx, branch, base),
    changedFileContents: (branch, base, file) =>
      gitx.changedFileContents(gitCtx, branch, base, file),
    diffstat: (branch, base) => gitx.diffstat(gitCtx, branch, base),
    // The review stage's subject (#2730): the branch as it stands against the
    // merge base, read before any PR exists.
    worktreeDiff: (branch, base) => gitx.worktreeDiff(gitCtx, branch, base),
    branchReversionBaseline: async (branch, remote, base) => {
      await gitx.fetchBranchRequired(gitCtx, base, remote);
      return gitx.branchReversionBaseline(gitCtx, branch, `${remote}/${base}`);
    },
    branchReversionDiffAt: (repo, baseRef) => gitx.branchReversionDiffAt(repo, baseRef),
    // Stale-base drift evidence (#2711). The remote-tracking ref only advances
    // on a fetch, and the last one ran when the attempt started — so refresh it
    // first, otherwise a base that moved mid-run reads as standing still and the
    // failure is charged to a branch that never broke. Best-effort throughout:
    // the fetch is unchecked and the probe degrades to "no movement observed".
    baseMovement: async (baseRef, sinceSha) => {
      const branch = baseRef.startsWith("origin/") ? baseRef.slice("origin/".length) : baseRef;
      await gitx.fetchBranch(gitCtx, branch).catch(() => {});
      return gitx.baseMovementSince(gitCtx, baseRef, sinceSha);
    },
    // FIX E: confirm the sandcastle worker branch actually landed on the host
    // before the merge gate. Try once, fetch on a miss, then re-check — a still
    // -absent branch escalates instead of silently bypassing feedback.
    branchPresent: async (branch) => {
      if (await gitx.branchExists(gitCtx, branch)) return true;
      await gitx.fetchBranch(gitCtx, branch);
      return gitx.branchExists(gitCtx, branch);
    },
    // Goal predicate own-merge signal (ADR 0057): true iff the worker branch
    // already landed in <base>, distinguishing own-merge close (done) from a
    // foreign close (claim-lost) when the guard observes the issue CLOSED.
    branchMerged: (branch, base) => gitx.branchMergedInto(gitCtx, branch, base),
    // Branch-resume discovery (issue #2397): list all remote afk/* refs so the
    // lifecycle can detect a prior pushed branch and resume instead of rebuilding.
    discoverBranches: () => gitx.listRemoteBranches(gitCtx, "afk/"),
    // Adoption evidence (#2865): a discovered branch is only prior work if it
    // carries commits the base does not. Without this the lifecycle cannot tell
    // finished work from the empty ref worktree creation pushes.
    branchCommitsAhead: (branch, base) => gitx.branchCommitsAhead(gitCtx, branch, base),
    // Attempt-adoption sanity check (#2416): one cheap open-PR census before
    // any agent run. The lifecycle owns exact body/head matching and adoption.
    // One census, one implementation: the exit-time orphaned-work check (#2893)
    // reads the same open-PR list through the same runtime helper.
    discoverOpenPullRequests: () => ghx.listOpenPullRequests(ghCtx),
  };
}
