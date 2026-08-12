import type { ProcessIssueDeps } from "../../../core/process-issue.js";
import * as ghx from "../../../runtime/gh.js";
import type { GhContext } from "../../../runtime/gh.js";
import { buildReviewGh } from "../../../runtime/review-gh.js";

/**
 * GitHub-issue port: every closure here binds ONE context (`ghCtx`) and nothing
 * else. `ghCtx.cwd` is the repo root and `ghCtx.repo` the `owner/name` slug, so
 * a caller never has to hand the builder a second, crossed context.
 */
export function buildGhPort(ghCtx: GhContext): ProcessIssueDeps["gh"] {
  return {
    viewLabels: (issue) => ghx.viewLabels(ghCtx, issue),
    editLabels: (issue, remove, add) => ghx.editLabels(ghCtx, issue, remove, add),
    ensureLabel: async (name) => {
      try {
        await ghx.ensureLabel(ghCtx, name);
      } catch {
        // best-effort: a missing typed label must never fail the close.
      }
    },
    comment: (issue, body) => ghx.comment(ghCtx, issue, body),
    editBody: (issue, body) => ghx.editBody(ghCtx, issue, body),
    close: (issue) => ghx.closeIssue(ghCtx, issue),
    listByLabel: (label) => ghx.listByLabel(ghCtx, label),
    issueClosed: (n) => ghx.issueClosed(ghCtx, n),
    issueReference: (n) => ghx.issueReference(ghCtx, n),
    // Trust-gate provenance (#621): author + promoter label actor, read from the
    // issue timeline. The promoter label is the LANE the claim was selected under
    // (`ready-for-agent`, `lane:go`, `lane:scout`) so a /go/scout issue resolves its
    // maintainer minter, not an absent `ready-for-agent` actor (#2602, #1101).
    issueTrust: (issue, promoterLabel) => ghx.issueTrust(ghCtx, issue, promoterLabel),
    // Repository visibility (#1101): folds into the trust policy so a PUBLIC
    // repo with no allowlist fails closed while a private one stays permissive.
    repoVisibility: () => ghx.repoVisibility(ghCtx),
    // Dynamic-base trust signals (write-access / CODEOWNERS) for the fail-closed author + promoter check (#1101, reusing #747).
    actorTrustSignals: ghx.createActorTrustLookup(ghCtx),
    externalApprovalActors: (issue) => ghx.externalApprovalActors(ghCtx, issue), // /approve-external authors, trust-resolved on claim (#2603)
    // HITL decision card (#935, S11a): post/update the card on escalation.
    // Best-effort: errors are caught in routeRecovery so they never block
    // the recovery path. Runs in the worktree root so gh resolves the repo.
    renderDecisionCard: async (issue) => {
      const { hitlCardCommand } = await import("../../hitl-card.js");
      await hitlCardCommand(["render", `--issue=${issue}`, `--root=${ghCtx.cwd}`]);
    },
  };
}

/**
 * Claim-arbiter port (ADR 0066): the atomic GitHub-native claim surface. Numeric
 * comment ids (via `gh api`) are the cross-host total order.
 */
export function buildClaimGhPort(ghCtx: GhContext): NonNullable<ProcessIssueDeps["claimGh"]> {
  return {
    postClaim: (issue, body) => ghx.postClaimComment(ghCtx, issue, body),
    listClaims: (issue) => ghx.listClaimComments(ghCtx, issue),
    concede: async (issue, body) => {
      try {
        await ghx.postClaimComment(ghCtx, issue, body);
      } catch {
        // best-effort: a failed concede ages out via the staleness predicate.
      }
    },
    // One human-visible audit comment when we recover a stale cross-host claim
    // (#627). Best-effort: a failed audit never abandons the won claim.
    audit: async (issue, body) => {
      try {
        await ghx.comment(ghCtx, issue, body);
      } catch {
        // best-effort observability; the claim is already won.
      }
    },
  };
}

/**
 * Re-seed trail port (#2731): ONE Issue comment upserted in place. The post goes
 * through the numeric-id REST surface because the edit needs that id — `gh issue
 * comment` does not expose it — and the edit reuses the existing edit-comment
 * primitive. Both are best-effort: the trail is a projection of the Attempt
 * record, so a refused post or patch costs fidelity, never a Re-seed round.
 */
export function buildReseedTrailPort(ghCtx: GhContext): NonNullable<ProcessIssueDeps["reseedTrailGh"]> {
  return {
    postComment: async (issue, body) => {
      try {
        return await ghx.postClaimComment(ghCtx, issue, body);
      } catch {
        return undefined;
      }
    },
    editComment: (commentId, body) => ghx.editComment(ghCtx, commentId, body),
  };
}

/**
 * PR-review ports: the two evidence surfaces that post through `ReviewGh` rather
 * than the plain issue API. Same single context as the issue port.
 */
export function buildReviewPorts(ghCtx: GhContext): Required<
  Pick<ProcessIssueDeps, "postBackpressureReview" | "postAdversarialReview">
> {
  return {
    // Non-blocking backpressure evidence review (#1279): render the executed
    // backpressure checks as ONE aggregated `event: COMMENT` review on the PR.
    // Reuses ReviewGh.postReview (COMMENT-only, no APPROVE/REQUEST_CHANGES) with
    // no inline comments — purely a top-level evidence ledger. Observability only;
    // it never touches the merge/park decision.
    postBackpressureReview: (pr, body) =>
      buildReviewGh(ghCtx).postReview(pr, { summary: body, comments: [] }),
    // The review verdict lands on the ISSUE (#2730). Review is the gate fold's
    // third stage and runs pre-PR, so the pull-request comment this replaced had
    // no pull request to address.
    postAdversarialReview: async ({ issue, body }) => {
      await ghx.comment(ghCtx, issue, body);
    },
  };
}
