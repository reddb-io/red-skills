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
      prepareFreshWorkerBranch: (input) =>
        gitx.prepareFreshWorkerBranch(gitCtx, { ...input, remote }),
    },
    mergeExec: gitx.mergeExec(gitCtx),
    remoteGit: gitx.gitExec(gitCtx),
  };
}
