import { describe, it, expect } from "vitest";
import type { RunOptions, RunResult } from "@ai-hero/sandcastle";
import {
  buildRunOptions,
  buildContinuousPushHook,
  interpretOutcome,
  isExhaustionError,
  runAgent,
  DONE_SIGNAL,
  BLOCKED_SIGNAL,
  COMPLETION_SIGNALS,
  DEFAULT_IDLE_TIMEOUT_S,
  DEFAULT_REMOTE,
  DEFAULT_MAX_ITERATIONS,
  parseMaxIterations,
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

  it("sets maxIterations to DEFAULT_MAX_ITERATIONS when unset (issue #322 regression guard)", () => {
    // sandcastle defaults maxIterations to 1, cutting the agent off before DONE.
    // buildRunOptions MUST set a generous ceiling — this guard would have caught
    // the missing setting that made every issue end no-sentinel → blocked:crashed.
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    expect(DEFAULT_MAX_ITERATIONS).toBeGreaterThan(1);
  });

  it("honours an explicit input.maxIterations override", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, maxIterations: 7 },
    );
    expect(opts.maxIterations).toBe(7);
  });

  it("honours an opt-in docker sandbox and a custom idle timeout", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, sandboxMode: "docker", idleTimeoutSeconds: 300 },
    );
    expect(opts.sandbox).toEqual({ __sandbox: "docker" });
    expect(opts.idleTimeoutSeconds).toBe(300);
  });

  it("does NOT inject any hooks when continuous push is not requested (default)", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.hooks).toBeUndefined();
  });

  it("injects an onWorktreeReady host hook with the initial push + post-commit install when continuousPush is on", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, continuousPush: true },
    );
    const hooks = opts.hooks?.host?.onWorktreeReady;
    expect(hooks).toHaveLength(1);
    const command = hooks?.[0]?.command ?? "";
    // It is a single portable `sh -c '...'` host command.
    expect(command.startsWith("sh -c ")).toBe(true);
    // (a) initial force-with-lease push of the worker branch up-front.
    expect(command).toContain("--force-with-lease");
    expect(command).toContain("HEAD:refs/heads/afk/wZ2R4/42-fix-oauth");
    expect(command).toContain(`git push ${DEFAULT_REMOTE} -u`);
    // (b) post-commit hook install into the worktree's own gitdir.
    expect(command).toContain("git rev-parse --git-dir");
    expect(command).toContain("hooks/post-commit");
    // The installed hook pushes HEAD after every commit (continuous push).
    expect(command).toContain(`git push ${DEFAULT_REMOTE} HEAD --force-with-lease`);
  });

  it("re-anchors sandcastle at the caller's cwd (the AFK attempt dir) when supplied", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, cwd: "/abs/attempt/dir" },
    );
    // cwd is forwarded verbatim so sandcastle puts `.sandcastle/` under the
    // attempt dir (.red/tmp/...), never at the repo root.
    expect(opts.cwd).toBe("/abs/attempt/dir");
  });

  it("leaves cwd undefined when omitted (sandcastle's process.cwd() default preserved)", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.cwd).toBeUndefined();
  });

  it("targets a custom remote when one is supplied", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, continuousPush: true, remote: "backup" },
    );
    const command = opts.hooks?.host?.onWorktreeReady?.[0]?.command ?? "";
    expect(command).toContain("git push backup -u");
    expect(command).toContain("git push backup HEAD --force-with-lease");
  });
});

describe("buildContinuousPushHook (issue #191)", () => {
  it("is best-effort: every push tolerates failure and the script never aborts the run", () => {
    const { command } = buildContinuousPushHook("afk/wZ2R4/42-fix-oauth", "origin");
    // The initial push falls back to a warn (|| echo ... >&2), never a non-zero exit.
    expect(command).toContain("|| echo");
    // The whole host-hook script ends with `exit 0` so a push/auth failure
    // cannot fail the onWorktreeReady hook and abort the iteration.
    expect(command).toContain("exit 0");
    // The installed post-commit hook is itself a pure side-effect (|| true).
    expect(command).toContain("|| true");
  });

  it("scopes the hook to the worktree's linked gitdir, not a fixed .git path", () => {
    const { command } = buildContinuousPushHook("afk/x/1-slug", "origin");
    // Uses `git rev-parse --git-dir` so a linked worktree's hooks dir is used —
    // the hook cannot leak into the primary checkout or a sibling worktree.
    expect(command).toContain("git rev-parse --git-dir");
    expect(command).not.toContain('.git/hooks/post-commit"');
  });

  it("is a single shell command string (the sandcastle host-hook shape)", () => {
    const hook = buildContinuousPushHook("afk/x/1-slug", "origin");
    expect(typeof hook.command).toBe("string");
    // Host hooks accept only { command, timeoutMs? } — no sudo on the host lane.
    expect(Object.keys(hook)).toEqual(["command"]);
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

describe("parseMaxIterations (RED_AFK_MAX_ITERATIONS, issue #322)", () => {
  it("parses a positive integer", () => {
    expect(parseMaxIterations("50")).toBe(50);
    expect(parseMaxIterations("1")).toBe(1);
  });

  it("falls back to undefined for missing / non-numeric / zero / negative values", () => {
    // undefined → buildRunOptions applies DEFAULT_MAX_ITERATIONS; an operator
    // typo must never disable the cap.
    expect(parseMaxIterations(undefined)).toBeUndefined();
    expect(parseMaxIterations("abc")).toBeUndefined();
    expect(parseMaxIterations("0")).toBeUndefined();
    expect(parseMaxIterations("-3")).toBeUndefined();
    expect(parseMaxIterations("2.5")).toBeUndefined();
    expect(parseMaxIterations("")).toBeUndefined();
  });
});

describe("isExhaustionError", () => {
  it("matches the per-runner exhaustion strings on a thrown error message", () => {
    expect(isExhaustionError(new Error("usage limit reached"))).toBe(true);
    expect(isExhaustionError(new Error("rate_limit_error: slow down"))).toBe(true);
    expect(isExhaustionError(new Error("session exhausted"))).toBe(true);
    expect(isExhaustionError({ stderr: "weekly cap hit" })).toBe(true);
    expect(isExhaustionError("please try again later")).toBe(true);
  });

  it("does not match an ordinary failure", () => {
    expect(isExhaustionError(new Error("tests failed: 2 failing"))).toBe(false);
    expect(isExhaustionError(undefined)).toBe(false);
    expect(isExhaustionError(null)).toBe(false);
  });
});

describe("runAgent — exhaustion", () => {
  it("maps a thrown exhaustion error to the exhausted outcome (no commits, no sentinel)", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("Claude usage limit reached; try again later");
      }),
      baseInput,
    );
    expect(r.outcome).toBe("exhausted");
    expect(r.branch).toBe("afk/wZ2R4/42-fix-oauth");
    expect(r.commits).toEqual([]);
    expect(r.completionSignal).toBeUndefined();
  });

  it("maps exhaustion text on stdout (no completion signal) to exhausted", async () => {
    const r = await runAgent(
      makeDeps(async () => fakeResult({ completionSignal: undefined, stdout: "quota exceeded for this org" })),
      baseInput,
    );
    expect(r.outcome).toBe("exhausted");
  });

  it("re-throws a non-exhaustion sandcastle error unchanged", async () => {
    await expect(
      runAgent(
        makeDeps(async () => {
          throw new Error("worktree add failed: fatal");
        }),
        baseInput,
      ),
    ).rejects.toThrow("worktree add failed");
  });
});
