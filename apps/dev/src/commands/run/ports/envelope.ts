import type { ProcessIssueDeps } from "../../../core/process-issue.js";
import * as ghx from "../../../runtime/gh.js";
import * as gitx from "../../../runtime/git.js";
import * as fsx from "../../../runtime/fs.js";
import type { GhContext } from "../../../runtime/gh.js";
import type { GitContext } from "../../../runtime/git.js";
import type { CurrentAttempt } from "../attempt.js";

/**
 * Terminal-Envelope port — the one small surface that genuinely reads BOTH the
 * gh and git contexts (it posts the envelope and stamps the head it describes),
 * plus the per-issue attempt dir its markers land in.
 */
export function buildEnvelopePort(
  ghCtx: GhContext,
  gitCtx: GitContext,
  current: CurrentAttempt,
): NonNullable<ProcessIssueDeps["envelope"]> {
  return {
    git: gitx.gitExec(gitCtx),
    poster: async (issue, body) => {
      await ghx.comment(ghCtx, issue, body);
      return true;
    },
    // Markers/posted land in the CURRENT attempt dir, set per issue by
    // buildProcessInput before each processIssue call.
    writeMarkers: (markers) => fsx.writeFailureMarkers(current.attemptDir, markers),
    writePosted: (posted) => fsx.writeEnvelopePosted(current.attemptDir, posted),
    issueReference: (issue) => ghx.issueReference(ghCtx, issue),
  };
}
