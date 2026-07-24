// Claim substrate shim — the implementation crossed into red-castle
// (`packages/red-castle/src/engine/tracker/claim.ts`, ADR 0113/0120: castle
// owns the claim truth). This re-export keeps every dev call site stable.
export {
  CLAIM_MARKER_VERSION,
  ClaimVerificationError,
  acquireClaim,
  parseClaimRecords,
  reconcileClaim,
  refreshClaimHeartbeats,
  renderClaimComment,
  renderConcedeOnBehalf,
  renderRecoveryAudit,
} from "@reddb-io/red-castle/engine";
export type {
  AcquireClaimOptions,
  ClaimDecision,
  ClaimGh,
  ClaimHeartbeat,
  ClaimHeartbeatBatchResult,
  ClaimKind,
  ClaimReconcileOptions,
  ClaimRecord,
  ClaimSelf,
  ClaimVerdict,
  ConcedeReason,
  RawClaimComment,
} from "@reddb-io/red-castle/engine";
