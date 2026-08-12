// Resume routing — repair custody for preserved Worker commits before the next
// Worker starts. The exit-time orphan refusal still owns newly-pushed work.

import { scrubOutbound } from "../../runtime/outbound-redaction.js";
import type { BranchAdoption } from "../branch-resume.js";
import { listOpenPr, type Exec } from "../merge.js";

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

  const existing = await listOpenPr(exec, repo, adoption.branch, target);
  if (existing !== undefined) return existing;
  const create = await exec([
    "gh",
    "-R",
    repo,
    "pr",
    "create",
    "--draft",
    "--base",
    target,
    "--head",
    adoption.branch,
    "--title",
    scrubOutbound(`resume: #${issue}`),
    "--body",
    scrubOutbound(`Resuming preserved Worker commits for #${issue}.\n\nCloses #${issue}`),
  ]);
  if (create.code !== 0) return undefined;
  return await listOpenPr(exec, repo, adoption.branch, target);
}
