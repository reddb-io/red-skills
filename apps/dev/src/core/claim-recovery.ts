import {
  renderConcededClaimSweepAudit,
  renderDeadClaimSweepAudit,
  renderStaleClaimSweepAudit,
  type ClaimedIssue,
  type StaleClaimRelease,
} from "./claim-staleness.js";
import { blockedLabelsIn, isRefused, planTransition } from "./state-transition.js";
import {
  LABEL_GO_LANE,
  LABEL_HUMAN,
  LABEL_READY,
  LABEL_RUNNING,
  LABEL_SCOUT_LANE,
} from "./triage-labels.js";

export interface ClaimRecoveryPlan {
  readonly remove: string[];
  readonly add: string[];
  readonly destination: string;
  readonly refusalReason?: string;
  readonly audit: string;
}

/** Plan the label restoration and audit for one stale or daemon-dead claim. */
export function planClaimRecovery(
  currentLabels: readonly string[],
  release: StaleClaimRelease,
  claimedIssue?: ClaimedIssue,
): ClaimRecoveryPlan {
  const parked = currentLabels.includes(LABEL_HUMAN) || blockedLabelsIn(currentLabels).length > 0;
  const isolatedLane = currentLabels.includes(LABEL_GO_LANE)
    ? LABEL_GO_LANE
    : currentLabels.includes(LABEL_SCOUT_LANE)
      ? LABEL_SCOUT_LANE
      : undefined;
  const transition = parked || isolatedLane ? undefined : planTransition(currentLabels, { kind: "queue" });
  const refused = transition && isRefused(transition) ? transition : undefined;
  const destination = isolatedLane ?? LABEL_READY;
  const remove = refused || !transition ? [LABEL_RUNNING] : [...transition.remove];
  const add = refused || !transition ? [] : [...transition.add];

  const deadOwners = new Set(claimedIssue?.deadOwners ?? []);
  const concededOwners = release.concededOwners ?? [];
  const releaseAudit = concededOwners.length > 0
    ? renderConcededClaimSweepAudit(concededOwners, destination)
    : release.staleOwners.some((owner) => deadOwners.has(owner))
      ? renderDeadClaimSweepAudit(release.staleOwners, destination)
      : renderStaleClaimSweepAudit(release.staleOwners, destination);
  const zeroCommitBranches = (claimedIssue?.attemptBranches ?? [])
    .filter((branch) => branch.commitsAhead === 0)
    .map((branch) => `\`${branch.branch}\``);
  const branchAudit = zeroCommitBranches.length === 0
    ? ""
    : `\n\nRemote attempt ${zeroCommitBranches.length === 1 ? "branch" : "branches"} ` +
      `${zeroCommitBranches.join(", ")} carried zero commits ahead of trunk and remained for branch cleanup policy.`;

  return {
    remove,
    add,
    destination,
    ...(refused ? { refusalReason: refused.reason } : {}),
    audit: releaseAudit + branchAudit,
  };
}
