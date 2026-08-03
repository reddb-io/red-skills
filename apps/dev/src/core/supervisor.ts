export {
  SUPERVISOR_DEFAULTS,
  evaluateDrainBudget,
  evaluateValidationAdmission,
  resolveSupervisorConfig,
  validateStallThresholds,
  validateSupervisorProgressThreshold,
  validateSupervisorStaleThreshold,
  type DrainBudgetStatus,
  type DrainBudgetTier,
  type ElasticResizeRequest,
  type ElasticShrinkMode,
  type SupervisorConfig,
  type SupervisorConfigReader,
  type ValidationAdmissionDecision,
  type ValidationAdmissionInput,
} from "./supervisor/config.js";
export {
  classifySupervisor,
  recordDeath,
  type CircuitDecision,
  type SupervisorHealth,
  type SupervisorLiveness,
} from "./supervisor/lifecycle.js";
export {
  type FleetHeartbeat,
  type FleetHeartbeatEmitResult,
  type HeartbeatSlotDetail,
  type HeartbeatSlotPid,
  type IterDirInfo,
  type ReconcileCandidate,
  type SpawnPolicy,
  type SupervisorDeps,
  type SupervisorEventKind,
  type SupervisorEventRecord,
  type SupervisorFs,
  type SupervisorGh,
  type SupervisorProc,
  type SweepWork,
  type SweepWorker,
  type TrunkFreshnessOutcome,
  type TrunkFreshnessStatus,
  type TrunkMirrorRefreshResult,
} from "./supervisor/types.js";
export {
  freshSlot,
  initSupervisorState,
  type ReapContestState,
  type SlotState,
  type SupervisorState,
} from "./supervisor/state.js";
export {
  buildWorkerBudgetEnvelope,
  buildCrashEnvelope,
  buildDiscardEnvelope,
  buildReaperEnvelope,
  buildWallClockCapEnvelope,
  decideCrashReconcile,
  reconcileDeadWorkerClaim,
} from "./supervisor/envelopes.js";
export { type TickResult } from "./supervisor/result.js";
export { HEARTBEAT_STATE_REPAIR_AFTER_TICKS } from "./supervisor/heartbeat.js";
export {
  pollStallDetector,
  reapStalledSlot,
  resolveReapContest,
  sweepParkedSlot,
  type ReapContestResolution,
  type ReapOptions,
} from "./supervisor/reaper.js";
export {
  dispatchReconcileIfPossible,
  handleDeadSlot,
  terminateAll,
} from "./supervisor/slot-actions.js";
export { guardedTick } from "./supervisor/guarded-tick.js";
export {
  workerUsage,
  hasResourceBudget,
  resourceBudgetBreach,
  sampleWorkerPeakRss,
} from "./supervisor/worker-accounting.js";
