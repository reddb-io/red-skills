// AFK execution backend public surface. Implementation lives in ./execution/ modules.

export type { AgentStreamEvent } from "@reddb-io/worker";
export { BLOCKED_SIGNAL, COMPLETION_SIGNALS, DONE_SIGNAL } from "@reddb-io/worker/engine";
export type { AgentOutput } from "./agent-output.js";
export { CODEX_EFFORTS, CLAUDE_EFFORTS, MINIMAX_EFFORTS } from "./runner-spec.js";
export {
  DEFAULT_GOAL_POLL_MS,
  DEFAULT_IDLE_TIMEOUT_S,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_REMOTE,
  DEFAULT_VITALS_SAMPLE_MS,
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
  isHostConfigRunnerError,
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
  AttemptProgressInfo,
  ImplementerRuntimeProjection,
  RunAgentInput,
  RunAgentResult,
  SandboxMode,
  SandcastleDeps,
} from "./execution/runtime.js";
export { startGoalWatch } from "./execution/goal-watch.js";
