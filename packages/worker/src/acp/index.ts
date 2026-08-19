// @reddb-io/worker/acp — the Worker body's ACP surface (ADR 0148).
//
// THE CUT: what runs inside the Worker is here; whether, when and where a
// Worker exists is redskilled's. `packages/worker/README.md` states the rule
// and `apps/redskilled/tests/acp-body-control-cut.test.ts` refuses both
// directions of drift.
export { runAcpWorkerCommand } from "./command.js";
export { runNativeAcpWorker } from "./native-worker.js";
export { WorkflowChildAgent, type ChildAgentSessionOptions } from "./child-agent.js";
export {
  createWorkerTerminalHost,
  DEFAULT_TERMINAL_OUTPUT_BYTE_LIMIT,
  type WorkerTerminalHost,
  type WorkerTerminalHostOptions,
} from "./terminal-host.js";
export {
  evaluateWorkerTerminalRequest,
  shellSegments,
  workerTerminalDenialMessage,
  workerTerminalDenialMeta,
  WORKER_DENIED_TERMINAL_PROGRAMS,
  type WorkerTerminalDecision,
  type WorkerTerminalDenial,
  type WorkerTerminalDenialReason,
  type WorkerTerminalRequest,
} from "./terminal-policy.js";
export {
  createWorkerPublisher,
  readWorktreePublication,
  WORKER_PUBLISH_METHOD,
  type WorkerPublication,
  type WorkerPublishOutcome,
  type WorkerPublisher,
  type WorkerPublisherOptions,
} from "./publish-request.js";
export {
  runTicketLoop,
  TICKET_LOOP_STAGES,
  reseedHandoff,
  type TicketGateRun,
  type TicketImplementOutcome,
  type TicketLoopDeps,
  type TicketLoopRecord,
  type TicketLoopResult,
  type TicketLoopStage,
  type TicketLoopTicket,
} from "./ticket-loop.js";
export {
  runWorkerLocalGate,
  readWorkspace,
  workspaceGlobs,
  changedFilesSince,
  type WorkerLocalGateOptions,
  type WorkerLocalGateResult,
} from "./local-gate.js";
export {
  createChildAcpSpinEpisode,
  type ChildAcpSpinEpisode,
  type ChildSpinObservation,
} from "./child-spin.js";
export {
  createAcpWorkerBudgetGraceRuntime,
  REDSKILLED_WORKER_BUDGET_GRACE_METHOD,
  type AcpWorkerBudgetGraceDeps,
  type AcpWorkerBudgetGraceRuntime,
  type WorkerBudgetExtensionBlocker,
  type WorkerBudgetGraceCheckpoint,
  type WorkerBudgetGraceControl,
  type WorkerBudgetGraceEnvelope,
} from "./budget-grace.js";
