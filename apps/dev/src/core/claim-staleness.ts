// Stale-claim classification shim — the implementation crossed into red-castle
// (`packages/worker/src/engine/tracker/claim-staleness.ts`, per the ADR
// 0113 module map: claim-staleness is castle substrate). This re-export keeps
// every dev call site stable.
export {
  DEFAULT_CLAIM_REFRESH_S,
  DEFAULT_CLAIM_STALE_TOLERANCE,
  DEFAULT_CLAIM_STALENESS,
  DEFAULT_CLAIM_REAPER_GRACE_S,
  DEFAULT_CLAIM_RECENT_COMMIT_PROTECTION_S,
  DEFAULT_CLAIM_REAPER,
  staleWindowS,
  classifyClaim,
  claimHolderVerdict,
  makeStaleClaimPredicate,
  classifyIssueClaims,
  renderStaleClaimSweepAudit,
  renderDeadClaimSweepAudit,
  renderConcededClaimSweepAudit,
  planStaleClaimSweep,
  resolveClaimStalenessConfig,
  resolveClaimReaperConfig,
} from "@reddb-io/worker/engine";
export type {
  ClaimStalenessConfig,
  ClaimReaperConfig,
  ClaimFreshness,
  ClaimHolderVerdict,
  IssueClaimState,
  ClaimedIssue,
  StaleClaimRelease,
} from "@reddb-io/worker/engine";
