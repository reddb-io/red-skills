import type { ProcessIssueDeps } from "../../../core/process-issue.js";
import * as gitx from "../../../runtime/git.js";
import type { GitContext } from "../../../runtime/git.js";

/**
 * Git ports: `git`, `mergeExec`, and `remoteGit` all bind the SAME `gitCtx`.
 * The remote name is the one non-context scalar the branch primitives need, so
 * it travels with the context instead of being read off a repo context here.
 */
export function buildGitPorts(
  gitCtx: GitContext,
  remote: string,
): Required<Pick<ProcessIssueDeps, "git" | "mergeExec" | "remoteGit">> {
  return {
    git: {
      headShortSha: () => gitx.headShortSha(gitCtx),
      deleteLocalBranch: (branch) => gitx.deleteLocalBranch(gitCtx, branch),
      // Make the resolved base ref current before sandcastle forks off it
      // (ADR 0031/#1380). Online workers fork from freshly-fetched
      // origin/<base>; offline workers may use the local base only when it is not
      // behind the last-known origin tip.
      resolveFreshBase: (input) => gitx.resolveFreshBase(gitCtx, input),
      fetchBase: async (base) => {
        await gitx.gitExec(gitCtx)(["fetch", remote, base]);
      },
      prepareFreshWorkerBranch: (input) =>
        gitx.prepareFreshWorkerBranch(gitCtx, { ...input, remote }),
    },
    mergeExec: gitx.mergeExec(gitCtx),
    remoteGit: gitx.gitExec(gitCtx),
  };
}
