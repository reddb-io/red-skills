import { describe, it, expect } from "vitest";
import type { RunOptions, RunResult } from "@reddb-io/red-castle";
import {
  buildRunOptions,
  buildContinuousPushHook,
  interpretOutcome,
  isExhaustionError,
  isTransientRunnerError,
  runAgent,
  effortForProvider,
  buildAgent,
  OPENROUTER_API_KEY_ENV,
  type AgentFactories,
  DONE_SIGNAL,
  BLOCKED_SIGNAL,
  COMPLETION_SIGNALS,
  DEFAULT_IDLE_TIMEOUT_S,
  DEFAULT_REMOTE,
  DEFAULT_MAX_ITERATIONS,
  CODEX_EFFORTS,
  CLAUDE_EFFORTS,
  parseMaxIterations,
  parseIdleTimeout,
  parseAttemptTimeout,
  startAttemptGuard,
  DEFAULT_ATTEMPT_TIMEOUT_S,
  type SandcastleDeps,
  type RunAgentInput,
  type AgentStreamEvent,
  type AttemptProgressInfo,
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
  handoffContent: "the handoff body",
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

  it("delivers the handoff as an INLINE prompt (not a promptFile template) with a named branch strategy", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    // #758: the handoff is passed inline (verbatim) so red-castle does NOT run
    // {{KEY}} substitution / `` !`cmd` `` expansion on opaque issue-body text.
    expect(opts.prompt).toBe("the handoff body");
    expect(opts.promptFile).toBeUndefined();
    expect(opts.branchStrategy).toEqual({ type: "branch", branch: "afk/wZ2R4/42-fix-oauth" });
  });

  it("passes a handoff with {{KEY}} / Rust-macro code spans through verbatim (no template expansion — #756/#758)", () => {
    // These tokens crash red-castle's template path: `{{KEY}}` -> "no matching
    // value" PromptError, and `` `assert!` `` -> false `` !` `` shell-exec.
    // Inline delivery must carry them byte-for-byte, never as promptFile.
    const trap = "Use `{{KEY}}`, `assert!` and `debug_assert!` — !`echo nope`.";
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), {
      ...baseInput,
      handoffContent: trap,
    });
    expect(opts.prompt).toBe(trap);
    expect(opts.promptFile).toBeUndefined();
    expect(opts.promptArgs).toBeUndefined();
  });

  it("threads systemPrompt into RunOptions when present, omits it otherwise", () => {
    const withSys = buildRunOptions(makeDeps(async () => fakeResult()), {
      ...baseInput,
      systemPrompt: "RULE: emit DONE last.",
    });
    expect(withSys.systemPrompt).toBe("RULE: emit DONE last.");
    const without = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(without.systemPrompt).toBeUndefined();
  });

  it("selects the agent provider from runner+model+effort", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.agent).toEqual({ __agent: "claude:claude-opus-4-8:high" });
    const codexOpts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, runner: "codex", model: "gpt-5.4", effort: "high" },
    );
    expect(codexOpts.agent).toEqual({ __agent: "codex:gpt-5.4:high" });
    // ADR 0059: opencode forwards its `openrouter/<vendor>/<model>` slug unchanged.
    const opencodeOpts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, runner: "opencode", model: "openrouter/anthropic/claude-sonnet-4", effort: "high" },
    );
    expect(opencodeOpts.agent).toEqual({ __agent: "opencode:openrouter/anthropic/claude-sonnet-4:high" });
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

  it("forwards the attempt dir to sandboxFor as the bind-mount path (issue #405)", () => {
    // Under docker/podman the attempt dir must be bind-mounted into the container
    // at the identical path so the worktree + proof-of-life lane are host-visible
    // — the precondition for arming the guard + heartbeat under isolation.
    const seen: Array<{ mode: string; mountPath: string | undefined }> = [];
    const deps: SandcastleDeps = {
      run: async () => fakeResult(),
      agentFor: (runner, model, opts) => fakeAgent(`${runner}:${model}:${opts?.effort ?? "-"}`),
      sandboxFor: (mode, opts) => {
        seen.push({ mode, mountPath: opts?.mountPath });
        return fakeSandbox(mode);
      },
    };
    buildRunOptions(deps, { ...baseInput, sandboxMode: "docker", cwd: "/red/tmp/workers/w1/42-a1" });
    expect(seen).toEqual([{ mode: "docker", mountPath: "/red/tmp/workers/w1/42-a1" }]);
  });

  it("passes no mount path to sandboxFor when cwd is absent (issue #405)", () => {
    const seen: Array<{ mode: string; mountPath: string | undefined }> = [];
    const deps: SandcastleDeps = {
      run: async () => fakeResult(),
      agentFor: (runner, model, opts) => fakeAgent(`${runner}:${model}:${opts?.effort ?? "-"}`),
      sandboxFor: (mode, opts) => {
        seen.push({ mode, mountPath: opts?.mountPath });
        return fakeSandbox(mode);
      },
    };
    buildRunOptions(deps, { ...baseInput, sandboxMode: "podman" });
    expect(seen).toEqual([{ mode: "podman", mountPath: undefined }]);
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

  it("leaves logging unset when no logPath is supplied (sandcastle default preserved)", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.logging).toBeUndefined();
  });

  it("drains sandcastle's file-log to the supplied logPath (#284 observability)", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, logPath: "/abs/attempt/dir/sandcastle.log" },
    );
    expect(opts.logging).toEqual({ type: "file", path: "/abs/attempt/dir/sandcastle.log" });
  });

  it("wires onAgentEvent into logging.onAgentStreamEvent for native-path liveness", () => {
    const seen: string[] = [];
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      {
        ...baseInput,
        logPath: "/abs/attempt/dir/sandcastle.log",
        onAgentEvent: (ev) => seen.push(ev.type),
      },
    );
    expect(opts.logging?.type).toBe("file");
    // The callback rides alongside the path so AFK can forward each stream
    // event to the agent lane the stall detector / monitor read.
    const cb = (opts.logging as { onAgentStreamEvent?: (e: AgentStreamEvent) => void }).onAgentStreamEvent;
    expect(cb).toBeTypeOf("function");
    cb?.({ type: "text", message: "hi", iteration: 1, timestamp: new Date(0) });
    expect(seen).toEqual(["text"]);
  });

  it("ignores onAgentEvent when no logPath is given (sandcastle only streams in file mode)", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, onAgentEvent: () => {} },
    );
    expect(opts.logging).toBeUndefined();
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
    expect(seen?.prompt).toBe("the handoff body");
    expect(seen?.completionSignal).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
    expect(seen?.branchStrategy).toEqual({ type: "branch", branch: "afk/wZ2R4/42-fix-oauth" });
  });
});

describe("defaultSandcastleDeps agentFor (FIX D — degrade safely, never throw)", () => {
  it("drops codex+max (omits effort) with a warn and still builds an agent", async () => {
    const { defaultSandcastleDeps } = await import("../src/core/execution.js");
    const deps = await defaultSandcastleDeps();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      // codex + "max" must NOT throw — it degrades to the provider default.
      const agent = deps.agentFor("codex", "gpt-5.4", { effort: "max" });
      expect(agent).toBeDefined();
      expect(warns.some((w) => w.includes("effort 'max' is not accepted by runner 'codex'"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it("keeps claude+max (no warn) — claude accepts the full union", async () => {
    const { defaultSandcastleDeps } = await import("../src/core/execution.js");
    const deps = await defaultSandcastleDeps();
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
    try {
      const agent = deps.agentFor("claude", "claude-opus-4-8", { effort: "max" });
      expect(agent).toBeDefined();
      expect(warns).toEqual([]);
    } finally {
      console.warn = orig;
    }
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

describe("parseIdleTimeout (RED_AFK_IDLE_TIMEOUT_S, FIX G)", () => {
  it("parses a positive integer", () => {
    expect(parseIdleTimeout("900")).toBe(900);
    expect(parseIdleTimeout("1")).toBe(1);
  });

  it("falls back to undefined for missing / non-numeric / zero / negative values", () => {
    // undefined → buildRunOptions applies DEFAULT_IDLE_TIMEOUT_S; an operator
    // typo must never disable the idle watchdog.
    expect(parseIdleTimeout(undefined)).toBeUndefined();
    expect(parseIdleTimeout("abc")).toBeUndefined();
    expect(parseIdleTimeout("0")).toBeUndefined();
    expect(parseIdleTimeout("-30")).toBeUndefined();
    expect(parseIdleTimeout("5.5")).toBeUndefined();
    expect(parseIdleTimeout("")).toBeUndefined();
  });
});

describe("effortForProvider (FIX D — per-provider effort gating)", () => {
  it("codex accepts low/medium/high/xhigh but NOT max", () => {
    expect(CODEX_EFFORTS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(effortForProvider("codex", "high")).toBe("high");
    expect(effortForProvider("codex", "xhigh")).toBe("xhigh");
    // "max" is out-of-range for codex → dropped (undefined → provider default).
    expect(effortForProvider("codex", "max")).toBeUndefined();
  });

  it("claude accepts the full union including max", () => {
    expect(CLAUDE_EFFORTS).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortForProvider("claude", "max")).toBe("max");
    expect(effortForProvider("claude", "high")).toBe("high");
  });

  it("passes undefined through unchanged (no effort requested)", () => {
    expect(effortForProvider("codex", undefined)).toBeUndefined();
    expect(effortForProvider("claude", undefined)).toBeUndefined();
  });
});

describe("buildAgent — provider mapping (ADR 0059 opencode wiring)", () => {
  // Recording fakes: each factory captures the (model, options) it was handed so
  // the pure runner→provider mapping is asserted without the real sandcastle deps.
  type Call = { model: string; options: unknown };
  function recorder() {
    const calls: Record<"claudeCode" | "codex" | "opencode", Call[]> = {
      claudeCode: [],
      codex: [],
      opencode: [],
    };
    const factories: AgentFactories = {
      claudeCode: (model, options) => (calls.claudeCode.push({ model, options }), fakeAgent("claude")),
      codex: (model, options) => (calls.codex.push({ model, options }), fakeAgent("codex")),
      opencode: (model, options) => (calls.opencode.push({ model, options }), fakeAgent("opencode")),
    };
    return { calls, factories };
  }

  it("routes claude/codex with gated effort as the numeric `effort` option", () => {
    const { calls, factories } = recorder();
    buildAgent(factories, "claude", "claude-opus-4-8", { effort: "max" }, {});
    expect(calls.claudeCode).toEqual([{ model: "claude-opus-4-8", options: { effort: "max" } }]);
    // codex tops out at xhigh → "max" is dropped to the provider default (no options).
    const warned: string[] = [];
    buildAgent(factories, "codex", "gpt-5.5", { effort: "max" }, {}, (m) => warned.push(m));
    expect(calls.codex).toEqual([{ model: "gpt-5.5", options: undefined }]);
    expect(warned.some((l) => l.includes("not accepted by runner 'codex'"))).toBe(true);
  });

  it("maps opencode effort to `variant` and forwards the <provider>/<model> slug unchanged", () => {
    const { calls, factories } = recorder();
    // The leading segment is opaque to AFK — OpenCode routes it. The contract
    // is: AFK forwards the slug as-is and lets OpenCode's dispatch decide.
    buildAgent(factories, "opencode", "openrouter/anthropic/claude-sonnet-4", { effort: "high" }, {});
    expect(calls.opencode).toEqual([
      { model: "openrouter/anthropic/claude-sonnet-4", options: { variant: "high" } },
    ]);
    // opencode never touches the claude/codex factories.
    expect(calls.claudeCode).toEqual([]);
    expect(calls.codex).toEqual([]);
  });

  it("forwards an OpenAI-style slug without mutating it", () => {
    const { calls, factories } = recorder();
    buildAgent(factories, "opencode", "openai/gpt-4o-mini", undefined, { OPENAI_API_KEY: "sk-oai-123" });
    expect(calls.opencode).toEqual([
      { model: "openai/gpt-4o-mini", options: { env: { OPENAI_API_KEY: "sk-oai-123" } } },
    ]);
  });

  it("forwards a MiniMax subscription slug without mutating it", () => {
    const { calls, factories } = recorder();
    buildAgent(factories, "opencode", "minimax/MiniMax-M3", undefined, { MINIMAX_API_KEY: "minimax-sub-456" });
    expect(calls.opencode).toEqual([
      { model: "minimax/MiniMax-M3", options: { env: { MINIMAX_API_KEY: "minimax-sub-456" } } },
    ]);
  });

  it("delivers OPENROUTER_API_KEY through OpenCodeOptions.env (back-compat with #626)", () => {
    const { calls, factories } = recorder();
    buildAgent(factories, "opencode", "openrouter/x/y", { effort: "low" }, { [OPENROUTER_API_KEY_ENV]: "sk-or-123" });
    expect(calls.opencode[0]!.options).toEqual({
      variant: "low",
      env: { OPENROUTER_API_KEY: "sk-or-123" },
    });
  });

  it("applies env precedence OPENAI > MINIMAX > OPENROUTER when multiple keys are set (ADR 0059 amendment)", () => {
    const { calls, factories } = recorder();
    buildAgent(
      factories,
      "opencode",
      "openai/gpt-4o-mini",
      undefined,
      {
        OPENAI_API_KEY: "sk-oai",
        MINIMAX_API_KEY: "minimax",
        OPENROUTER_API_KEY: "sk-or",
      },
    );
    // OPENAI wins; only the winning key rides in `env`.
    expect(calls.opencode[0]!.options).toEqual({ env: { OPENAI_API_KEY: "sk-oai" } });
  });

  it("promotes MINIMAX over OPENROUTER when OpenAI is absent", () => {
    const { calls, factories } = recorder();
    buildAgent(
      factories,
      "opencode",
      "minimax/MiniMax-M3",
      undefined,
      { MINIMAX_API_KEY: "minimax", OPENROUTER_API_KEY: "sk-or" },
    );
    expect(calls.opencode[0]!.options).toEqual({ env: { MINIMAX_API_KEY: "minimax" } });
  });

  it("omits env when no precedence entry is set and omits variant when no effort is requested", () => {
    const { calls, factories } = recorder();
    buildAgent(factories, "opencode", "openrouter/x/y", undefined, {});
    // No effort and no key → no options object at all (provider defaults apply;
    // OpenCode surfaces its own auth error in the agent's environment).
    expect(calls.opencode).toEqual([{ model: "openrouter/x/y", options: undefined }]);
  });

  it("does not gate opencode effort — any AgentEffort maps straight to variant", () => {
    const { calls, factories } = recorder();
    const warned: string[] = [];
    // "max" is rejected by codex but is a legal opencode variant; no warn fires.
    buildAgent(factories, "opencode", "openrouter/x/y", { effort: "max" }, {}, (m) => warned.push(m));
    expect(calls.opencode[0]!.options).toEqual({ variant: "max" });
    expect(warned).toEqual([]);
  });
});

describe("runAgent — FIX F continuous-push under isolation warning", () => {
  function captureWarn(): { warn: (m: string) => void; lines: string[] } {
    const lines: string[] = [];
    return { warn: (m) => lines.push(m), lines };
  }

  it("warns when continuousPush is requested under docker isolation", async () => {
    const { warn, lines } = captureWarn();
    const deps = { ...makeDeps(async () => fakeResult()), warn };
    await runAgent(deps, { ...baseInput, continuousPush: true, sandboxMode: "docker" });
    expect(lines.some((l) => l.includes("continuous-push is unavailable under docker"))).toBe(true);
  });

  it("warns under podman isolation too", async () => {
    const { warn, lines } = captureWarn();
    const deps = { ...makeDeps(async () => fakeResult()), warn };
    await runAgent(deps, { ...baseInput, continuousPush: true, sandboxMode: "podman" });
    expect(lines.some((l) => l.includes("continuous-push is unavailable under podman"))).toBe(true);
  });

  it("does NOT warn for the default noSandbox mode (continuous-push works there)", async () => {
    const { warn, lines } = captureWarn();
    const deps = { ...makeDeps(async () => fakeResult()), warn };
    await runAgent(deps, { ...baseInput, continuousPush: true, sandboxMode: "none" });
    expect(lines).toEqual([]);
  });
});

describe("runAgent — FIX J env application", () => {
  it("applies input.env onto process.env before the run (noSandbox mechanism)", async () => {
    const key = "RED_AFK_TEST_CARGO_TARGET_DIR";
    const prior = process.env[key];
    delete process.env[key];
    let seenAtRunTime: string | undefined;
    try {
      await runAgent(
        makeDeps(async () => {
          // The agent inherits this worker process's env, so by run() time the
          // env must already be applied.
          seenAtRunTime = process.env[key];
          return fakeResult();
        }),
        { ...baseInput, env: { [key]: "/opt/cargo-target/slot-3" } },
      );
      expect(seenAtRunTime).toBe("/opt/cargo-target/slot-3");
      expect(process.env[key]).toBe("/opt/cargo-target/slot-3");
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("is a no-op when no env is supplied", async () => {
    // Just proves the empty-env path does not throw.
    const r = await runAgent(makeDeps(async () => fakeResult()), baseInput);
    expect(r.outcome).toBe("done");
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

  // FIX H: sandcastle rejects with Effect-style errors that may nest the quota
  // text under .cause / .error rather than a top-level .message/.stdout/.stderr.
  it("matches exhaustion text nested under a .cause chain", () => {
    expect(isExhaustionError({ message: "agent failed", cause: { message: "usage limit reached" } })).toBe(true);
  });

  it("matches exhaustion text nested under an arbitrary structured field", () => {
    expect(isExhaustionError({ _tag: "AgentError", detail: { reason: "rate_limit_error" } })).toBe(true);
  });

  it("matches a custom toString() carrying the quota text (no plain string field)", () => {
    const effectLike = {
      _tag: "ExecError",
      toString() {
        return "ExecError: weekly cap hit";
      },
    };
    expect(isExhaustionError(effectLike)).toBe(true);
  });

  it("still does not match a nested ordinary failure (broadening cannot misclassify)", () => {
    expect(isExhaustionError({ message: "build failed", cause: { message: "tsc: 3 errors" } })).toBe(false);
  });

  it("terminates on a cyclic error graph without looping", () => {
    const a: Record<string, unknown> = { message: "boom" };
    a.self = a;
    expect(isExhaustionError(a)).toBe(false);
  });
});

describe("isTransientRunnerError", () => {
  it("matches Codex transport/setup failures that should not crash the worker", () => {
    expect(
      isTransientRunnerError(
        new Error("failed to connect to websocket: HTTP error: 502 Bad Gateway, url: wss://chatgpt.com/backend-api/codex/responses"),
      ),
    ).toBe(true);
    expect(
      isTransientRunnerError(
        new Error("Error: thread/start: thread/start failed: failed to load configuration: No such file or directory (os error 2)"),
      ),
    ).toBe(true);
    expect(isTransientRunnerError(new Error("exec failed: exec failed: spawn sh ENOENT"))).toBe(true);
    expect(isTransientRunnerError(new Error("cwd does not exist: /tmp/.red/tmp/workers/wAAAA/17-a1"))).toBe(true);
  });

  it("matches provider server-side overload (529 / overloaded_error / 503) — temporary, not a crash", () => {
    expect(
      isTransientRunnerError(
        new Error("claude-code exited with code 1: API Error: 529 Overloaded. This is a server-side issue, usually temporary"),
      ),
    ).toBe(true);
    expect(isTransientRunnerError(new Error('{"type":"error","error":{"type":"overloaded_error"}}'))).toBe(true);
    expect(isTransientRunnerError(new Error("HTTP error: 503 Service Unavailable"))).toBe(true);
  });

  it("does not match ordinary agent/work failures", () => {
    expect(isTransientRunnerError(new Error("worktree add failed: fatal"))).toBe(false);
    expect(isTransientRunnerError(new Error("tests failed: 2 failing"))).toBe(false);
    // A 529 elsewhere in unrelated prose is overwhelmingly the status code; a
    // bare number like 5290 must NOT match (word-boundary guard).
    expect(isTransientRunnerError(new Error("processed 5290 records"))).toBe(false);
  });
});

describe("runAgent — server overload (529) is transient, never a crash", () => {
  it("maps a thrown 529 Overloaded to runner-transient (not a rethrow/no-sentinel)", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("claude-code exited with code 1: API Error: 529 Overloaded. This is a server-side issue, usually temporary");
      }),
      baseInput,
    );
    expect(r.outcome).toBe("runner-transient");
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

describe("runAgent — runner transient failures", () => {
  it("maps a thrown Codex websocket 502 to runner-transient instead of rethrowing", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("failed to connect to websocket: HTTP error: 502 Bad Gateway, url: wss://chatgpt.com/backend-api/codex/responses");
      }),
      { ...baseInput, runner: "codex", model: "gpt-5.4" },
    );
    expect(r.outcome).toBe("runner-transient");
    expect(r.branch).toBe("afk/wZ2R4/42-fix-oauth");
    expect(r.commits).toEqual([]);
    expect(r.stdout).toContain("failed to connect to websocket");
  });
});

// ---- attempt progress guard (proof-of-progress, PR-A) ----

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A manual scheduler: captures the periodic fn so the test pumps ticks. */
function manualScheduler() {
  const fns: Array<() => void> = [];
  const schedule = (fn: () => void, _ms: number) => {
    fns.push(fn);
    return () => {
      const i = fns.indexOf(fn);
      if (i >= 0) fns.splice(i, 1);
    };
  };
  const tick = async () => {
    for (const fn of [...fns]) fn();
    await flush();
  };
  return { schedule, tick };
}

describe("parseAttemptTimeout", () => {
  it("accepts a positive integer, rejects 0 / negative / non-numeric / undefined", () => {
    expect(parseAttemptTimeout("2700")).toBe(2700);
    expect(parseAttemptTimeout("0")).toBeUndefined();
    expect(parseAttemptTimeout("-5")).toBeUndefined();
    expect(parseAttemptTimeout("abc")).toBeUndefined();
    expect(parseAttemptTimeout(undefined)).toBeUndefined();
  });
  it("documents a sane default", () => {
    expect(DEFAULT_ATTEMPT_TIMEOUT_S).toBeGreaterThan(0);
  });
});

describe("startAttemptGuard — commit-anchored progress watchdog", () => {
  it("aborts once the cap elapses with no new commit", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // t=1000 anchor: head observed, deadline = 1000
    expect(aborted).toBe(false);
    clock = 1050;
    await sched.tick(); // 50ms < cap → alive
    expect(aborted).toBe(false);
    clock = 1100;
    await sched.tick(); // 100ms >= cap, head unchanged → abort
    expect(aborted).toBe(true);
    expect(g.firedTimeout()).toBe(true);
    g.stop();
  });

  it("resets the deadline when HEAD advances (a new commit is real progress)", async () => {
    let clock = 0;
    let head = "sha1";
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => head,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    clock = 10;
    await sched.tick(); // anchor at sha1, deadline=10
    clock = 90;
    head = "sha2";
    await sched.tick(); // commit advanced → deadline resets to 90
    clock = 150;
    await sched.tick(); // 150-90=60 < cap → alive
    expect(aborted).toBe(false);
    clock = 200;
    await sched.tick(); // 200-90=110 >= cap, no further commit → abort
    expect(aborted).toBe(true);
  });

  it("treats an unresolved HEAD (no commit yet) as no progress and still caps", async () => {
    let clock = 0;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => undefined,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    clock = 50;
    await sched.tick();
    expect(aborted).toBe(false);
    clock = 100;
    await sched.tick(); // 100 >= cap from start → abort
    expect(aborted).toBe(true);
  });
});

describe("startAttemptGuard — goal predicate (ADR 0057)", () => {
  it("aborts 'goal-moot' once the claimed issue is observed CLOSED", async () => {
    let clock = 0;
    let closed = false;
    const sched = manualScheduler();
    let reason: string | undefined;
    const g = startAttemptGuard({
      capMs: 100_000, // huge cap so only the goal predicate can fire here
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      goalProbe: async () => closed,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // open → no-op
    expect(reason).toBeUndefined();
    expect(g.firedGoalMoot()).toBe(false);
    closed = true;
    clock = 50;
    await sched.tick(); // CLOSED observed → moot
    expect(reason).toBe("goal-moot");
    expect(g.firedGoalMoot()).toBe(true);
    expect(g.firedTimeout()).toBe(false); // a goal-moot is NOT a stall
    g.stop();
  });

  it("never aborts while the issue is open or the read fails (uncertainty is a no-op)", async () => {
    let clock = 0;
    const states: Array<boolean | undefined> = [false, undefined];
    let i = 0;
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100_000,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => clock,
      schedule: sched.schedule,
      goalProbe: async () => states[i++],
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // false → no-op
    clock = 50;
    await sched.tick(); // undefined (read failed) → no-op
    expect(aborted).toBe(false);
    expect(g.firedGoalMoot()).toBe(false);
    g.stop();
  });

  it("swallows a goalProbe rejection and treats it as uncertainty (no abort)", async () => {
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100_000,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      now: () => 0,
      schedule: sched.schedule,
      goalProbe: async () => {
        throw new Error("gh exploded");
      },
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick();
    expect(aborted).toBe(false);
    expect(g.firedGoalMoot()).toBe(false);
    g.stop();
  });
});

describe("runAgent — attempt guard wiring", () => {
  it("returns the 'goal-moot' outcome when the goal predicate aborts the run", async () => {
    let closed = false;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => 0,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 1,
      headProbe: async () => "static",
      goalProbe: async () => closed,
    });
    await sched.tick(); // open → run continues
    closed = true;
    await sched.tick(); // CLOSED → abort with goal-moot
    const res = await p;
    expect(res.outcome).toBe("goal-moot");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("returns the 'timeout' outcome when the guard aborts a stalled run", async () => {
    let clock = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, { ...baseInput, attemptTimeoutSeconds: 1, headProbe: async () => "static" });
    await sched.tick(); // anchor (capMs = 1000, deadline = 0)
    clock = 1000;
    await sched.tick(); // 1000 >= cap → abort → run rejects
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("does not arm the guard (normal completion) when no timeout/headProbe is supplied", async () => {
    const deps = makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await runAgent(deps, baseInput); // no attemptTimeoutSeconds / headProbe
    expect(res.outcome).toBe("done");
  });

  it("passes the abort signal through to sandcastle's run options when armed", async () => {
    let seenSignal: AbortSignal | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(async (o) => {
        seenSignal = o.signal;
        return fakeResult({ completionSignal: DONE_SIGNAL });
      }),
      schedule: manualScheduler().schedule,
    };
    await runAgent(deps, { ...baseInput, attemptTimeoutSeconds: 60, headProbe: async () => "x" });
    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("fires the proof-of-life heartbeat AND aborts a stall under docker isolation (issue #405)", async () => {
    // The guard arms identically regardless of sandbox mode — runAgent gates only
    // on (attemptTimeoutSeconds + headProbe), never on sandboxMode. So under
    // docker/podman the externalized heartbeat (onHeartbeat) fires each poll and a
    // stalled-but-busy agent is aborted the same as no-sandbox (AC1 + AC2).
    let clock = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    const ticks: AttemptProgressInfo[] = [];
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      sandboxMode: "docker",
      cwd: "/red/tmp/workers/w1/42-a1",
      attemptTimeoutSeconds: 1,
      headProbe: async () => "static",
      onHeartbeat: (info) => ticks.push(info),
    });
    await sched.tick(); // anchor; heartbeat fires
    expect(ticks).toHaveLength(1);
    clock = 1000;
    await sched.tick(); // cap elapsed, head static → abort
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(ticks.length).toBeGreaterThanOrEqual(2); // proof-of-life fired under isolation
  });
});

describe("startAttemptGuard — diff-anchored progress (ADR 0051, codex false-stall fix)", () => {
  it("resets the deadline when the worktree diff GROWS even with no new commit (the #895 case)", async () => {
    // codex edits without committing: head static, but changed-line volume climbs
    // each poll. The guard must treat that as progress and never false-stall.
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // t=0 anchor (volume=10)
    for (const [t, v] of [
      [50, 60],
      [120, 140],
      [220, 300],
      [400, 497],
    ] as const) {
      clock = t;
      volume = v;
      await sched.tick(); // volume changed since last poll → deadline resets
      expect(aborted).toBe(false);
    }
  });

  it("still aborts when neither a commit NOR an edit lands within the cap (a genuine stall)", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    let aborted = false;
    const g = startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => 42, // volume frozen → no edit signal
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // anchor
    clock = 1050;
    await sched.tick();
    expect(aborted).toBe(false);
    clock = 1100;
    await sched.tick(); // cap elapsed, no commit + frozen volume → abort
    expect(aborted).toBe(true);
    expect(g.firedTimeout()).toBe(true);
  });

  it("treats a volume change in EITHER direction as progress (edits then a partial revert)", async () => {
    let clock = 0;
    let volume = 100;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick(); // anchor (100)
    clock = 80;
    volume = 60; // a revert is still activity
    await sched.tick();
    clock = 160;
    await sched.tick(); // only 80ms since the last change → alive
    expect(aborted).toBe(false);
  });

  it("degrades to commit-anchored when progressProbe rejects (never the cause of a false reset)", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => {
        throw new Error("worktree gone");
      },
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick();
    clock = 1100;
    await sched.tick(); // probe throws → no edit signal → commit-anchored abort
    expect(aborted).toBe(true);
  });
});

describe("startAttemptGuard — commit-anchored hard cap (issue #637, busy-but-unproductive loop)", () => {
  it("aborts at the hard cap when periodic edits keep resetting the soft deadline but no commit lands", async () => {
    // The #579 worker: code committed, then an open-ended re-validation loop
    // that occasionally touches a test file. Every edit resets the soft
    // deadline, so without the hard cap the guard never fires.
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let reason: string | undefined;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 200,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // t=0 anchor (first head = spawn commit anchor)
    for (const [t, v] of [
      [50, 60],
      [100, 140],
      [150, 300],
    ] as const) {
      clock = t;
      volume = v;
      await sched.tick(); // edit each poll → soft deadline resets, still under the hard cap
      expect(reason).toBeUndefined();
    }
    clock = 200;
    volume = 999;
    await sched.tick(); // edits continue, but 200ms since last commit >= hardCapMs → abort
    expect(reason).toBe("hard-cap");
  });

  it("a new commit re-anchors the hard cap", async () => {
    let clock = 0;
    let head = "sha1";
    let volume = 10;
    const sched = manualScheduler();
    let reason: string | undefined;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 200,
      headProbe: async () => head,
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // t=0 anchor at sha1
    clock = 150;
    head = "sha2";
    await sched.tick(); // commit → hard cap re-anchors to 150
    clock = 300;
    volume = 20;
    await sched.tick(); // 300-150=150 < 200 → alive (edits within the re-anchored cap)
    expect(reason).toBeUndefined();
    clock = 350;
    volume = 30;
    await sched.tick(); // 350-150=200 >= hardCapMs, no further commit → abort
    expect(reason).toBe("hard-cap");
  });

  it("reports 'stalled' (not 'hard-cap') when the plain soft deadline expires first", async () => {
    let clock = 0;
    const sched = manualScheduler();
    let reason: string | undefined;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      hardCapMs: 200,
      headProbe: async () => "sha-static",
      progressProbe: async () => 42, // frozen volume → no edit signal
      now: () => clock,
      schedule: sched.schedule,
      abort: (r) => {
        reason = r;
      },
    });
    await sched.tick(); // anchor
    clock = 100;
    await sched.tick(); // soft cap expires with no commit and no edit
    expect(reason).toBe("stalled");
  });

  it("without hardCapMs, continuous edits extend indefinitely (ADR 0051 behaviour unchanged)", async () => {
    let clock = 0;
    let volume = 10;
    const sched = manualScheduler();
    let aborted = false;
    startAttemptGuard({
      capMs: 100,
      intervalMs: 50,
      headProbe: async () => "sha-static",
      progressProbe: async () => volume,
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {
        aborted = true;
      },
    });
    await sched.tick();
    for (const [t, v] of [
      [90, 20],
      [180, 30],
      [600, 40],
      [1200, 50],
    ] as const) {
      clock = t;
      volume = v;
      await sched.tick();
      expect(aborted).toBe(false);
    }
  });
});

describe("runAgent — hard cap wiring (issue #637)", () => {
  it("returns the 'timeout' outcome when the hard cap aborts an editing-but-never-committing run", async () => {
    let clock = 0;
    let volume = 0;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 1,
      attemptHardCapSeconds: 2,
      headProbe: async () => "static",
      progressProbe: async () => ++volume, // an edit every poll → soft deadline never expires
    });
    await sched.tick(); // anchor
    clock = 1000;
    await sched.tick(); // soft cap held open by the edit signal → alive
    clock = 2000;
    await sched.tick(); // hard cap (2s) since anchor with no commit → abort
    const res = await p;
    expect(res.outcome).toBe("timeout");
    expect(controller.signal.reason).toBeInstanceOf(Error);
    expect(String((controller.signal.reason as Error).message)).toContain("hard cap");
  });
});

// ---- lane-idle stall reaper wiring (issue #363) ----

describe("runAgent — lane-idle reaper wiring", () => {
  // The reaper reasons in epoch SECONDS; `now` here is ms (runAgent divides /1000).
  const BASE_MS = 1_000_000_000;
  const BASE_S = BASE_MS / 1000;

  it("returns the 'no-sentinel' outcome when the lane-idle reaper reaps an idle run", async () => {
    let clock = BASE_MS;
    const sched = manualScheduler();
    const controller = new AbortController();
    const deps: SandcastleDeps = {
      ...makeDeps(
        (o) =>
          new Promise<RunResult>((_resolve, reject) => {
            o.signal?.addEventListener("abort", () => reject(o.signal?.reason ?? new Error("aborted")));
          }),
      ),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      laneIdlePollSeconds: 30,
      // Lane last wrote at spawn; a sleep-only inner child — no agent turns, no
      // build/test descendant under the tree, flat cpu.
      laneMtimeProbe: () => BASE_S,
      inspectTree: () => [{ command: "sleep", cpu: 0 }],
    });
    await sched.tick(); // worker age 0 → not yet a candidate
    clock = BASE_MS + 1800_000; // idle 1800s ≥ kill, no active descendant → reap
    await sched.tick();
    const res = await p;
    expect(res.outcome).toBe("no-sentinel");
    expect(res.branch).toBe(baseInput.branch);
    expect(res.commits).toEqual([]);
  });

  it("does NOT reap when an active vitest descendant is under the tree (busy-predicate)", async () => {
    let clock = BASE_MS;
    const sched = manualScheduler();
    const controller = new AbortController();
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => controller,
    };
    const p = runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      laneMtimeProbe: () => BASE_S,
      inspectTree: () => [{ command: "vitest", cpu: 0 }], // a test run mid-flight
    });
    clock = BASE_MS + 9999_000; // idle far past kill, but busy → never reaped
    await sched.tick();
    expect(controller.signal.aborted).toBe(false);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });

  it("does not arm the reaper when the lane probe / tree inspector are absent", async () => {
    const deps = makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await runAgent(deps, {
      ...baseInput,
      laneIdleThresholdSeconds: 600,
      laneIdleKillThresholdSeconds: 1800,
      // no laneMtimeProbe / inspectTree → reaper stays disarmed
    });
    expect(res.outcome).toBe("done");
  });
});

// ---- externalized proof-of-life (PR-B): onTick / onHeartbeat ----

describe("startAttemptGuard — onTick (externalized heartbeat cadence)", () => {
  it("fires onTick every poll with the progress info, independent of aborting", async () => {
    let clock = 1000;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    startAttemptGuard({
      capMs: 100_000, // large → never aborts in this test
      intervalMs: 50,
      headProbe: async () => "sha1",
      now: () => clock,
      schedule: sched.schedule,
      abort: () => {},
      onTick: (i) => ticks.push(i),
    });
    await sched.tick();
    clock = 1050;
    await sched.tick();
    expect(ticks.length).toBe(2);
    expect(ticks[0]!.head).toBe("sha1");
    expect(typeof ticks[0]!.lastProgressMs).toBe("number");
    expect(typeof ticks[0]!.nowMs).toBe("number");
  });
});

describe("runAgent — forwards onHeartbeat to the guard tick", () => {
  it("invokes onHeartbeat per poll while the run is in flight (armed)", async () => {
    let clock = 0;
    const sched = manualScheduler();
    const ticks: AttemptProgressInfo[] = [];
    let resolveRun: ((r: RunResult) => void) | undefined;
    const deps: SandcastleDeps = {
      ...makeDeps(() => new Promise<RunResult>((res) => (resolveRun = res))),
      now: () => clock,
      schedule: sched.schedule,
      makeAbortController: () => new AbortController(),
    };
    const p = runAgent(deps, {
      ...baseInput,
      attemptTimeoutSeconds: 600,
      headProbe: async () => "static",
      onHeartbeat: (i) => ticks.push(i),
    });
    await sched.tick(); // one poll while the run hangs → onHeartbeat fires
    expect(ticks.length).toBeGreaterThanOrEqual(1);
    resolveRun?.(fakeResult({ completionSignal: DONE_SIGNAL }));
    const res = await p;
    expect(res.outcome).toBe("done");
  });
});
