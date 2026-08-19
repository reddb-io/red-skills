import type { RunOptions, RunResult } from "@reddb-io/worker";
import {
  DONE_SIGNAL,
  type RunAgentInput,
  type SandcastleDeps,
} from "../src/core/execution.js";

// Sentinel provider objects - the adapter only forwards them to `run`, so a
// fake is enough to assert which agent/sandbox was selected.
export const fakeAgent = (id: string) => ({ __agent: id }) as unknown as RunOptions["agent"];
export const fakeSandbox = (id: string) => ({ __sandbox: id }) as unknown as RunOptions["sandbox"];

export function makeDeps(
  run: (o: RunOptions) => Promise<RunResult>,
): SandcastleDeps {
  return {
    run,
    agentFor: (runner, model, opts) => fakeAgent(`${runner}:${model}:${opts?.effort ?? "-"}`),
    sandboxFor: (mode) => fakeSandbox(mode),
  };
}

export const baseInput: RunAgentInput = {
  runner: "claude",
  model: "claude-opus-4-8",
  effort: "high",
  handoffPath: "/wt/handoff.md",
  handoffContent: "the handoff body",
  branch: "afk/wZ2R4/42-fix-oauth",
};

// A valid AgentOutput block (ADR 0090, #932). baseInput's runner is claude,
// which is schema-enabled, so a `done` outcome is only honoured when stdout
// carries a valid <agent-output> - embed it in the default fakeResult stdout so
// the DONE-path tests reflect the structured-output contract.
export const VALID_AGENT_OUTPUT =
  '<agent-output>{"success":true,"summary":"did the work","key_changes_made":["x"],"key_learnings":["y"],"should_fully_stop":false}</agent-output>';

export function fakeResult(over: Partial<RunResult> = {}): RunResult {
  return {
    iterations: [],
    completionSignal: DONE_SIGNAL,
    stdout: `ok
${VALID_AGENT_OUTPUT}`,
    commits: [{ sha: "abc1234" }],
    branch: "afk/wZ2R4/42-fix-oauth",
    ...over,
  } as RunResult;
}
