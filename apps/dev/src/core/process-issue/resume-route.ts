// Resume routing — repair custody for preserved Worker commits before the next
// Worker starts. The exit-time orphan refusal still owns newly-pushed work.

import type { BranchAdoption } from "../branch-resume.js";
import { openDraftPr, type Exec } from "../merge.js";

export interface ResumeRouteInput {
  readonly adoption: BranchAdoption;
  readonly repo: string;
  readonly target: string;
  readonly issue: number;
}

/**
 * Open the durable draft route for a preserved branch proven to carry commits.
 * The head/base probe makes this idempotent across concurrent claims and forge
 * races; Landing later reuses the same pull request and marks it ready.
 */
export async function ensureResumeRoute(
  exec: Exec,
  input: ResumeRouteInput,
): Promise<number | undefined> {
  const { adoption, repo, target, issue } = input;
  if (
    adoption.kind !== "adopt" ||
    adoption.commitsAhead === undefined ||
    adoption.commitsAhead <= 0 ||
    adoption.hasOpenPullRequest
  ) {
    return undefined;
  }

  return await openDraftPr(exec, {
    repo,
    branch: adoption.branch,
    target,
    n: issue,
    title: "",
    prTitle: `resume: #${issue}`,
    body: `Resuming preserved Worker commits for #${issue}.\n\nCloses #${issue}`,
  });
}
