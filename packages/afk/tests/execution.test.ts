import { describe, it, expect } from "vitest";
import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import {
  buildRunOptions,
  interpretOutcome,
  runAgent,
  DONE_SIGNAL,
  BLOCKED_SIGNAL,
  COMPLETION_SIGNALS,
  DEFAULT_IDLE_TIMEOUT_S,
  type SandcastleDeps,
  type RunAgentInput,
} from "../src/core/execution.js";

// Sentinel provider objects — the adapter only forwards them to `run`, so a
// fake is enough to assert which agent/sandbox was selected.
const fakeAgent = (id: string) => ({ __agent: id }) as unknown as RunOptions["agent"];
const fakeSandbox = (id: string) => ({ __sandbox: id }) as unknown as RunOptions["sandbox"];

function makeDeps(
  run: (o: RunOptions) => Promise<RunResult>,
): SandcastleDeps {
  return {
    run,
    agentFor: (runner, model, opts) => fakeAgent(`${runner}:${model}:${opts?.effort ?? "-"}`),
    sandboxFor: (mode) => fakeSandbox(mode),
  };
}

const baseInput: RunAgentInput = {
  runner: "claude",
  model: "claude-opus-4-8",
  effort: "high",
  handoffPath: "/wt/handoff.md",
  branch: "afk/wZ2R4/42-fix-oauth",
};

function fakeResult(over: Partial<RunResult> = {}): RunResult {
  return {
    iterations: [],
    completionSignal: DONE_SIGNAL,
    stdout: "ok",
    commits: [{ sha: "abc1234" }],
    branch: "afk/wZ2R4/42-fix-oauth",
    ...over,
  } as RunResult;
}

describe("interpretOutcome", () => {
  it("maps the DONE sentinel to done", () => {
    expect(interpretOutcome(DONE_SIGNAL)).toBe("done");
  });
  it("maps the BLOCKED sentinel to blocked", () => {
    expect(interpretOutcome(BLOCKED_SIGNAL)).toBe("blocked");
  });
  it("maps an absent / unknown signal to no-sentinel", () => {
    expect(interpretOutcome(undefined)).toBe("no-sentinel");
    expect(interpretOutcome("something else")).toBe("no-sentinel");
  });
});

describe("buildRunOptions", () => {
  it("registers both AFK sentinels as completion signals", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.completionSignal).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
    expect(COMPLETION_SIGNALS).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
  });

  it("uses the handoff as promptFile and a named branch strategy", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.promptFile).toBe("/wt/handoff.md");
    expect(opts.branchStrategy).toEqual({ type: "branch", branch: "afk/wZ2R4/42-fix-oauth" });
    // Inline prompt must not be set when a promptFile is used.
    expect(opts.prompt).toBeUndefined();
  });

  it("selects the agent provider from runner+model+effort", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.agent).toEqual({ __agent: "claude:claude-opus-4-8:high" });
    const codexOpts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, runner: "codex", model: "gpt-5.4", effort: "high" },
    );
    expect(codexOpts.agent).toEqual({ __agent: "codex:gpt-5.4:high" });
  });

  it("defaults the sandbox to none and the idle timeout to 600s", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.sandbox).toEqual({ __sandbox: "none" });
    expect(opts.idleTimeoutSeconds).toBe(DEFAULT_IDLE_TIMEOUT_S);
  });

  it("honours an opt-in docker sandbox and a custom idle timeout", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, sandboxMode: "docker", idleTimeoutSeconds: 300 },
    );
    expect(opts.sandbox).toEqual({ __sandbox: "docker" });
    expect(opts.idleTimeoutSeconds).toBe(300);
  });
});

describe("runAgent", () => {
  it("normalises a DONE RunResult", async () => {
    const r = await runAgent(makeDeps(async () => fakeResult()), baseInput);
    expect(r).toEqual({
      outcome: "done",
      branch: "afk/wZ2R4/42-fix-oauth",
      commits: [{ sha: "abc1234" }],
      completionSignal: DONE_SIGNAL,
      stdout: "ok",
    });
  });

  it("normalises a BLOCKED RunResult", async () => {
    const r = await runAgent(
      makeDeps(async () => fakeResult({ completionSignal: BLOCKED_SIGNAL, commits: [] })),
      baseInput,
    );
    expect(r.outcome).toBe("blocked");
    expect(r.commits).toEqual([]);
  });

  it("treats a run that produced no completion signal as no-sentinel", async () => {
    const r = await runAgent(
      makeDeps(async () => fakeResult({ completionSignal: undefined })),
      baseInput,
    );
    expect(r.outcome).toBe("no-sentinel");
  });

  it("passes the built options straight through to sandcastle run", async () => {
    let seen: RunOptions | undefined;
    await runAgent(
      makeDeps(async (o) => {
        seen = o;
        return fakeResult();
      }),
      baseInput,
    );
    expect(seen?.promptFile).toBe("/wt/handoff.md");
    expect(seen?.completionSignal).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
    expect(seen?.branchStrategy).toEqual({ type: "branch", branch: "afk/wZ2R4/42-fix-oauth" });
  });
});
