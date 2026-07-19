// AFK execution backend public surface. Implementation lives in ./execution/ modules.

export type { AgentStreamEvent } from "@reddb-io/red-castle";
export { BLOCKED_SIGNAL, COMPLETION_SIGNALS, DONE_SIGNAL } from "@reddb-io/red-castle/engine";
export type { AgentOutput } from "./agent-output.js";
export { CODEX_EFFORTS, CLAUDE_EFFORTS, MINIMAX_EFFORTS } from "./runner-spec.js";
export {
  DEFAULT_ATTEMPT_HARD_CAP_S,
  DEFAULT_ATTEMPT_TIMEOUT_S,
  DEFAULT_IDLE_TIMEOUT_S,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_REMOTE,
  OPENROUTER_API_KEY_ENV,
  buildAgent,
  buildRunOptions,
  defaultSandcastleDeps,
  effortForProvider,
  enforceStructuredOutput,
  extractSignalKill,
  interpretCompletion,
  interpretOutcome,
  isExhaustionError,
  isTransientRunnerError,
  parseIdleTimeout,
  parseMaxIterations,
  runAgent,
} from "./execution/runtime.js";
export { buildContinuousPushHook, buildNoLeakCommitMsgHook } from "./execution/host-hooks.js";
export type {
  AgentEffort,
  AgentFactories,
  AgentOutcome,
  AgentRunner,
  RunAgentInput,
  RunAgentResult,
  SandboxMode,
  SandcastleDeps,
} from "./execution/runtime.js";
export { exceedsBudget, startAttemptGuard } from "./execution/attempt-guard.js";
export type {
  AttemptActivityUsage,
  AttemptBudget,
  AttemptBudgetUsage,
  AttemptProgressInfo,
  AttemptTimeoutReason,
} from "./execution/attempt-guard.js";
