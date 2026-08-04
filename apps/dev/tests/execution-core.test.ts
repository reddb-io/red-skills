import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RunOptions } from "@reddb-io/red-castle";
import {
  buildRunOptions,
  defaultSandcastleDeps,
  buildContinuousPushHook,
  buildNoLeakCommitMsgHook,
  interpretOutcome,
  interpretCompletion,
  enforceStructuredOutput,
  isExhaustionError,
  isTransientRunnerError,
  extractSignalKill,
  runAgent,
  effortForProvider,
  buildAgent,
  OPENROUTER_API_KEY_ENV,
  type AgentFactories,
  type SandcastleDeps,
  DONE_SIGNAL,
  BLOCKED_SIGNAL,
  COMPLETION_SIGNALS,
  DEFAULT_IDLE_TIMEOUT_S,
  DEFAULT_REMOTE,
  DEFAULT_MAX_ITERATIONS,
  CODEX_EFFORTS,
  CLAUDE_EFFORTS,
  MINIMAX_EFFORTS,
  parseMaxIterations,
  parseIdleTimeout,
  type AgentStreamEvent,
  type AttemptProgressInfo,
} from "../src/core/execution.js";

import {
  baseInput,
  fakeAgent,
  fakeSandbox,
  fakeResult,
  makeDeps,
  VALID_AGENT_OUTPUT,
} from "./execution-test-helpers.js";

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

describe("extractSignalKill (#1308 — signal-killed detection)", () => {
  it("detects SIGKILL (exit code 137) from an Orchestrator-style message", () => {
    const err = new Error("claude-code exited with code 137:\nstderr output");
    expect(extractSignalKill(err)).toEqual({ signal: "SIGKILL", exitCode: 137 });
  });

  it("detects SIGTERM (exit code 143)", () => {
    const err = new Error("claude-code exited with code 143:\n");
    expect(extractSignalKill(err)).toEqual({ signal: "SIGTERM", exitCode: 143 });
  });

  it("detects SIGINT (exit code 130)", () => {
    expect(extractSignalKill(new Error("agent exited with code 130:"))).toEqual({
      signal: "SIGINT",
      exitCode: 130,
    });
  });

  it("returns a generic SIG<N> name for an unmapped signal number", () => {
    const err = new Error("agent exited with code 160:");
    const result = extractSignalKill(err);
    expect(result).toEqual({ signal: "SIG32", exitCode: 160 });
  });

  it("returns null for a regular non-zero exit code (< 128)", () => {
    expect(extractSignalKill(new Error("agent exited with code 1:\nerr"))).toBeNull();
    expect(extractSignalKill(new Error("agent exited with code 127:\nerr"))).toBeNull();
  });

  it("returns null when the message contains no exit code pattern", () => {
    expect(extractSignalKill(new Error("some other error"))).toBeNull();
    expect(extractSignalKill("plain string")).toBeNull();
  });

  it("returns null for exit codes above 192", () => {
    expect(extractSignalKill(new Error("agent exited with code 200:\nerr"))).toBeNull();
  });
});

describe("interpretCompletion (ADR 0082 — structured wins, sentinel fallback)", () => {
  const structured = (success: boolean) => ({
    success,
    summary: "s",
    key_changes_made: [],
    key_learnings: [],
    should_fully_stop: false,
  });

  it("maps a valid structured success:true to done regardless of the signal", () => {
    expect(interpretCompletion(structured(true), undefined)).toBe("done");
    expect(interpretCompletion(structured(true), BLOCKED_SIGNAL)).toBe("done");
  });

  it("maps a valid structured success:false to blocked", () => {
    expect(interpretCompletion(structured(false), DONE_SIGNAL)).toBe("blocked");
  });

  it("falls back to the sentinel path when there is no structured output", () => {
    expect(interpretCompletion(undefined, DONE_SIGNAL)).toBe("done");
    expect(interpretCompletion(undefined, BLOCKED_SIGNAL)).toBe("blocked");
    expect(interpretCompletion(undefined, undefined)).toBe("no-sentinel");
  });
});

describe("enforceStructuredOutput (ADR 0090, #932)", () => {
  it("keeps a claude DONE that carries a valid AgentOutput", () => {
    const r = enforceStructuredOutput("claude", "done", `log\n${VALID_AGENT_OUTPUT}`);
    expect(r).toEqual({ outcome: "done" });
  });

  it("downgrades a claude DONE with a missing AgentOutput to no-sentinel", () => {
    const r = enforceStructuredOutput("claude", "done", "just prose, no tag");
    expect(r.outcome).toBe("no-sentinel");
    expect(r.rejectedReason).toBe("missing");
  });

  it("downgrades a claude DONE with a schema-invalid AgentOutput", () => {
    const r = enforceStructuredOutput("claude", "done", '<agent-output>{"success":true}</agent-output>');
    expect(r.outcome).toBe("no-sentinel");
    expect(r.rejectedReason).toContain("schema");
  });

  it("does NOT gate a non-schema runner (codex keeps the text sentinel)", () => {
    expect(enforceStructuredOutput("codex", "done", "no tag here")).toEqual({ outcome: "done" });
  });

  it("only gates the done outcome — blocked / no-sentinel pass through untouched", () => {
    expect(enforceStructuredOutput("claude", "blocked", "no tag")).toEqual({ outcome: "blocked" });
    expect(enforceStructuredOutput("claude", "no-sentinel", "no tag")).toEqual({ outcome: "no-sentinel" });
  });
});

describe("buildRunOptions", () => {
  it("registers both AFK sentinels + the claude structured-output tag as completion signals", () => {
    // ADR 0082 / #919: the claude runner also terminates on the structured
    // `<agent-output>` block so it can complete without the text sentinel.
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.completionSignal).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL, "</agent-output>"]);
    expect(COMPLETION_SIGNALS).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
  });

  it("keeps non-claude runners on the sentinels alone (claude-first rollout)", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, runner: "codex", model: "gpt-5.4" },
    );
    expect(opts.completionSignal).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
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

  it("projects the selected runner into sandbox construction", () => {
    let received: unknown;
    const deps: SandcastleDeps = {
      ...makeDeps(async () => fakeResult()),
      sandboxFor: (_mode, opts) => {
        received = opts;
        return { __sandbox: "none" } as never;
      },
    };

    buildRunOptions(deps, { ...baseInput, runner: "codex", model: "gpt-5.4" });

    expect(received).toEqual({ runner: "codex" });
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

  it("targets the conventional worktree directly inside the worker workspace", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), {
      ...baseInput,
      cwd: "/red/tmp/workers/w1/42",
    });

    expect(opts.cwd).toBe("/red/tmp/workers/w1/42");
    expect(opts.worktreePath).toBe("/red/tmp/workers/w1/42/worktree");
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

  it("injects the no-leak commit-msg host hook when continuous push is not requested (#1366)", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    const hooks = opts.hooks?.host?.onWorktreeReady;
    // Two host hooks now: [0] worktree-path capture (ADR 0103), [1] no-leak commit-msg.
    expect(hooks).toHaveLength(2);
    expect(hooks?.[0]?.command ?? "").toContain(".worktree-path");
    const command = hooks?.[1]?.command ?? "";
    expect(command.startsWith("sh -c ")).toBe(true);
    // It must NOT carry the continuous-push behaviour when push is off.
    expect(command).not.toContain("--force-with-lease");

    expect(command).toContain('hd="$gd/afk-hooks"');
    expect(command).toContain('"$hd/commit-msg"');
    expect(command).toContain("claude.ai/code/session_");
    expect(command).toContain("sensitive environment variable value");
    expect(command).toContain('git config --worktree core.hooksPath "$hd"');
  });

  it("injects the no-leak hook + continuous-push hook when continuousPush is on", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, continuousPush: true },
    );
    const hooks = opts.hooks?.host?.onWorktreeReady;
    // Three host hooks now: [0] worktree-path capture (ADR 0103), [1] no-leak
    // commit-msg, [2] continuous push (#1224).
    expect(hooks).toHaveLength(3);
    expect(hooks?.[0]?.command ?? "").toContain(".worktree-path");
    expect(hooks?.[1]?.command ?? "").toContain('"$hd/commit-msg"');
    const command = hooks?.[2]?.command ?? "";
    // It is a single portable `sh -c '...'` host command.
    expect(command.startsWith("sh -c ")).toBe(true);
    // (a) initial force-with-lease push of the worker branch up-front.
    expect(command).toContain("--force-with-lease");
    expect(command).toContain("HEAD:refs/heads/afk/wZ2R4/42-fix-oauth");
    expect(command).toContain(`git push ${DEFAULT_REMOTE} -u`);
    // (b) post-commit hook install into the worktree's own AFK-owned hooks dir
    // (`$hd` = `$gd/afk-hooks`, so the path is assembled from shell vars).
    expect(command).toContain("git rev-parse --absolute-git-dir");
    expect(command).toContain('hd="$gd/afk-hooks"');
    expect(command).toContain('"$hd/post-commit"');
    // The installed hook pushes HEAD after every commit (continuous push).
    expect(command).toContain(`git push ${DEFAULT_REMOTE} HEAD --force-with-lease`);
    // (c) the worktree's core.hooksPath is redirected (worktree-scoped) so the
    // consumer repo's commit-phase hooks are bypassed for AFK's commits (#840).
    expect(command).toContain("git config extensions.worktreeConfig true");
    expect(command).toContain('git config --worktree core.hooksPath "$hd"');
  });

  it("re-anchors sandcastle at the caller's cwd (the AFK attempt dir) when supplied", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, cwd: "/abs/attempt/dir" },
    );
    // cwd is forwarded verbatim so sandcastle puts `.red-castle/` under the
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

  it("drains sandcastle's narration as TOONL into the supplied Worker log (#3220)", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, logPath: "/abs/attempt/dir/sandcastle.log" },
    );
    expect(opts.logging).toMatchObject({
      type: "file",
      path: "/abs/attempt/dir/sandcastle.log",
      format: "toonl",
      kindPrefix: "worker",
    });
  });

  it("wires a capture-time redactLine into file logging (#1368 leak masking)", () => {
    const opts = buildRunOptions(
      makeDeps(async () => fakeResult()),
      { ...baseInput, logPath: "/abs/attempt/dir/sandcastle.log" },
    );
    const redact = (opts.logging as { redactLine?: (t: string) => string }).redactLine;
    expect(redact).toBeTypeOf("function");
    expect(redact!("see https://claude.ai/code/session_abc123 now")).toBe(
      "see [REDACTED_CLAUDE_SESSION] now",
    );
    // Non-leaking machine markers pass through byte-identical.
    const marker = "<!-- afk:claim v1 worker=w kind=claim runner=codex -->";
    expect(redact!(marker)).toBe(marker);
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
    // Index [2]: the continuous-push hook rides behind the worktree-path capture
    // ([0]) and no-leak commit-msg ([1]) hooks.
    const command = opts.hooks?.host?.onWorktreeReady?.[2]?.command ?? "";
    expect(command).toContain("git push backup -u");
    expect(command).toContain("git push backup HEAD --force-with-lease");
  });

  it("omits steerProvider when no steerFile is given", () => {
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), baseInput);
    expect(opts.steerProvider).toBeUndefined();
  });

  it("creates a steerProvider that reads the file and returns its text on the first call (#2337)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "steer-test-"));
    const steerPath = join(tmp, "steer.toon");
    const { encode } = await import("@reddb-io/toon");
    writeFileSync(steerPath, encode({ text: "focus on the failing test" }), "utf8");
    const consumed: number[] = [];
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), {
      ...baseInput,
      steerFile: steerPath,
      onSteerConsumed: (iteration) => consumed.push(iteration),
    });
    expect(opts.steerProvider).toBeTypeOf("function");
    const text = await opts.steerProvider!(2);
    expect(text).toBe("focus on the failing test");
    expect(existsSync(steerPath)).toBe(false);
    expect(consumed).toEqual([2]);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("steerProvider calls onSteerConsumed with the exact iteration number (#2337)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "steer-iter-"));
    const steerPath = join(tmp, "steer.toon");
    const { encode } = await import("@reddb-io/toon");
    writeFileSync(steerPath, encode({ text: "check logs" }), "utf8");
    const consumed: number[] = [];
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), {
      ...baseInput,
      steerFile: steerPath,
      onSteerConsumed: (iteration) => consumed.push(iteration),
    });
    await opts.steerProvider!(5);
    expect(consumed).toEqual([5]);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("steerProvider returns undefined and does not call onSteerConsumed when file is absent (#2337)", async () => {
    const consumed: number[] = [];
    const opts = buildRunOptions(makeDeps(async () => fakeResult()), {
      ...baseInput,
      steerFile: "/nonexistent/path/steer.toon",
      onSteerConsumed: (iteration) => consumed.push(iteration),
    });
    const text = await opts.steerProvider!(3);
    expect(text).toBeUndefined();
    expect(consumed).toEqual([]);
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

  it("scopes the hook + the core.hooksPath redirect to the worktree, not a fixed .git path", () => {
    const { command } = buildContinuousPushHook("afk/x/1-slug", "origin");
    // Uses `git rev-parse --absolute-git-dir` so a linked worktree's own gitdir is
    // used — the hook cannot leak into the primary checkout or a sibling worktree.
    expect(command).toContain("git rev-parse --absolute-git-dir");
    expect(command).not.toContain('.git/hooks/post-commit"');
    // The core.hooksPath redirect is set `--worktree` ONLY — never a bare
    // `git config core.hooksPath`, which would silence the consumer's hooks in the
    // primary checkout too (the primary branch is sacred, #840).
    expect(command).not.toContain('git config core.hooksPath');
  });

  it("is a single shell command string (the sandcastle host-hook shape)", () => {
    const hook = buildContinuousPushHook("afk/x/1-slug", "origin");
    expect(typeof hook.command).toBe("string");
    // Host hooks accept only { command, timeoutMs? } — no sudo on the host lane.
    expect(Object.keys(hook)).toEqual(["command"]);
  });
});

describe("buildNoLeakCommitMsgHook (issue #1366)", () => {
  it("installs a commit-msg hook that rejects Claude session links and sensitive env values", () => {
    const repo = mkdtempSync(join(tmpdir(), "afk-no-leak-hook-"));
    try {
      execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
      execFileSync("sh", ["-c", buildNoLeakCommitMsgHook().command], { cwd: repo, stdio: "ignore" });

      const hook = join(repo, ".git", "afk-hooks", "commit-msg");
      expect(existsSync(hook)).toBe(true);

      const clean = join(repo, "clean-msg");
      writeFileSync(clean, "Add public summary\n\nRefs #1366\n", "utf8");
      execFileSync(hook, [clean], { cwd: repo, env: { ...process.env, TEST_TOKEN: "dummysecretvalue" } });

      const sessionLeak = join(repo, "session-leak-msg");
      writeFileSync(sessionLeak, "Add summary\n\nclaude.ai/code/session_abc123\n", "utf8");
      expect(() => execFileSync(hook, [sessionLeak], { cwd: repo })).toThrow();

      const secretLeak = join(repo, "secret-leak-msg");
      writeFileSync(secretLeak, "Add summary\n\ndummysecretvalue\n", "utf8");
      expect(() =>
        execFileSync(hook, [secretLeak], { cwd: repo, env: { ...process.env, TEST_TOKEN: "dummysecretvalue" } }),
      ).toThrow();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
      stdout: `ok\n${VALID_AGENT_OUTPUT}`,
      agentOutput: {
        success: true,
        summary: "did the work",
        key_changes_made: ["x"],
        key_learnings: ["y"],
        should_fully_stop: false,
      },
    });
  });

  it("normalises a BLOCKED RunResult", async () => {
    // Use plain stdout (no AgentOutput tag) so the sentinel drives the outcome.
    // With a valid success:true AgentOutput, interpretCompletion returns "done"
    // (structured wins) — that is a different test case.
    const r = await runAgent(
      makeDeps(async () =>
        fakeResult({ completionSignal: BLOCKED_SIGNAL, commits: [], stdout: "blocked, no structured output" }),
      ),
      baseInput,
    );
    expect(r.outcome).toBe("blocked");
    expect(r.commits).toEqual([]);
  });

  it("treats a run that produced no completion signal as no-sentinel", async () => {
    // Use plain stdout (no AgentOutput tag) so the sentinel path returns no-sentinel.
    const r = await runAgent(
      makeDeps(async () =>
        fakeResult({ completionSignal: undefined, stdout: "no signal, no structured output" }),
      ),
      baseInput,
    );
    expect(r.outcome).toBe("no-sentinel");
  });

  it("maps a signal-kill AgentError (exit code 137) to signal-killed outcome (#1308)", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("claude-code exited with code 137:\nkilled by OOM");
      }),
      baseInput,
    );
    expect(r.outcome).toBe("signal-killed");
    expect(r.stdout).toMatch(/SIGKILL/);
    expect(r.stdout).toMatch(/137/);
  });

  it("maps a SIGTERM AgentError (exit code 143) to signal-killed outcome (#1308)", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("claude-code exited with code 143:\nharness watchdog");
      }),
      baseInput,
    );
    expect(r.outcome).toBe("signal-killed");
    expect(r.stdout).toMatch(/SIGTERM/);
  });

  it("still maps a regular non-zero exit (exit code 1) to no-sentinel (#1308)", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("claude-code exited with code 1:\ngeneral error");
      }),
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
    expect(seen?.completionSignal).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL, "</agent-output>"]);
    expect(seen?.branchStrategy).toEqual({ type: "branch", branch: "afk/wZ2R4/42-fix-oauth" });
  });

  it("reads a valid structured AgentOutput block as the outcome (ADR 0082, #919)", async () => {
    // A run that emitted the structured block but NO `<promise>` sentinel now
    // yields a definite outcome instead of no-sentinel (the #788 failure class).
    const output = {
      success: true,
      summary: "Wired the structured-output completion adapter.",
      key_changes_made: ["execution.ts"],
      key_learnings: [],
      should_fully_stop: false,
    };
    const stdout = `work log\n<agent-output>${JSON.stringify(output)}</agent-output>\n`;
    const r = await runAgent(
      makeDeps(async () => fakeResult({ completionSignal: "</agent-output>", stdout })),
      baseInput,
    );
    expect(r.outcome).toBe("done");
    expect(r.agentOutput).toEqual(output);
  });

  it("maps a structured success:false block to blocked, structured wins over the sentinel", async () => {
    const output = {
      success: false,
      summary: "Contradictory acceptance criteria.",
      key_changes_made: [],
      key_learnings: ["spec conflict"],
      should_fully_stop: false,
    };
    // Even with a DONE sentinel present, the structured block is authoritative.
    const stdout = `<agent-output>${JSON.stringify(output)}</agent-output>\n${DONE_SIGNAL}`;
    const r = await runAgent(
      makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL, stdout })),
      baseInput,
    );
    expect(r.outcome).toBe("blocked");
    expect(r.agentOutput).toEqual(output);
  });

  it("downgrades to no-sentinel when the structured block is malformed (ADR 0082 — all invalid forms gate)", async () => {
    // ADR 0082: missing, invalid-json, and schema-invalid all downgrade "done" to
    // "no-sentinel" for schema-capable runners (claude). A malformed block is not a
    // free pass to the text sentinel — the agent must emit a valid block to claim done.
    const stdout = `<agent-output>{not valid json}</agent-output>\n${DONE_SIGNAL}`;
    const r = await runAgent(
      makeDeps(async () => fakeResult({ completionSignal: DONE_SIGNAL, stdout })),
      baseInput,
    );
    expect(r.outcome).toBe("no-sentinel");
    expect(r.agentOutput).toBeUndefined();
  });
});

describe("defaultSandcastleDeps agentFor (FIX D — degrade safely, never throw)", () => {
  it("spawns a codex no-sandbox worker without Claude shell state", async () => {
    const previous = {
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
      CLAUDE_ENV_FILE: process.env.CLAUDE_ENV_FILE,
      BASH_ENV: process.env.BASH_ENV,
      ENV: process.env.ENV,
    };
    Object.assign(process.env, {
      CLAUDE_CODE_ENTRYPOINT: "host-cli",
      CLAUDE_ENV_FILE: "/tmp/shell-snapshot",
      BASH_ENV: "/tmp/bash-env",
      ENV: "/tmp/sh-env",
    });

    try {
      const deps = await defaultSandcastleDeps();
      const sandbox = deps.sandboxFor("none", { runner: "codex" });
      if (sandbox.tag !== "none") throw new Error("expected no-sandbox provider");
      const handle = await sandbox.create({ worktreePath: process.cwd(), env: {} });
      const result = await handle.exec(
        `printf 'claude=[%s] snapshot=[%s] bash=[%s] env=[%s]' "$CLAUDE_CODE_ENTRYPOINT" "$CLAUDE_ENV_FILE" "$BASH_ENV" "$ENV"`,
      );

      expect(result.stdout).toBe("claude=[] snapshot=[] bash=[] env=[]");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

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

  it("MINIMAX_EFFORTS contains only 'low' — the sole non-thinking tier MiniMax-M3 accepts (#794)", () => {
    expect(MINIMAX_EFFORTS).toEqual(["low"]);
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

  it("routes claude-minimax to the claude-code provider with MiniMax env + forced MiniMax-M3 model (PRD #788)", () => {
    const { calls, factories } = recorder();
    // The resolved tier model is discarded — the lane always forces MiniMax-M3 —
    // and the MiniMax key rides in as the two Anthropic vars on the inner spawn.
    // Effort "high" is capped to "low" (#794): MiniMax-M3 rejects thinking:{type:enabled}.
    buildAgent(factories, "claude-minimax", "claude-opus-4-8", { effort: "high" }, { MINIMAX_API_KEY: "mm-key-789" });
    expect(calls.claudeCode).toEqual([
      {
        model: "MiniMax-M3",
        options: {
          effort: "low",
          env: {
            ANTHROPIC_API_KEY: "mm-key-789",
            ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
            CLAUDE_CODE_SIMPLE: "1",
          },
        },
      },
    ]);
    // claude-minimax never touches the codex/opencode factories.
    expect(calls.codex).toEqual([]);
    expect(calls.opencode).toEqual([]);
  });

  it("omits the env block when MINIMAX_API_KEY is absent (lane unusable, claude-code surfaces its own auth error)", () => {
    const { calls, factories } = recorder();
    buildAgent(factories, "claude-minimax", "claude-opus-4-8", undefined, {});
    // No key + no effort → effort is still forced to "low" (thinking guard); no env block.
    expect(calls.claudeCode).toEqual([{ model: "MiniMax-M3", options: { effort: "low" } }]);
  });

  it("caps claude-minimax effort to 'low' — MiniMax-M3 rejects thinking:{type:enabled} from higher tiers (#794)", () => {
    const { calls, factories } = recorder();
    const warned: string[] = [];
    // "high" would trigger thinking:{type:"enabled"} which MiniMax-M3 rejects → capped to "low".
    buildAgent(factories, "claude-minimax", "x", { effort: "high" }, { MINIMAX_API_KEY: "k" }, (m) => warned.push(m));
    expect(calls.claudeCode[0]!.options).toMatchObject({ effort: "low" });
    expect(warned.some((l) => l.includes("triggers thinking") && l.includes("'high'"))).toBe(true);
  });

  it("accepts 'low' effort for claude-minimax without warning (the only non-thinking tier)", () => {
    const { calls, factories } = recorder();
    const warned: string[] = [];
    buildAgent(factories, "claude-minimax", "x", { effort: "low" }, { MINIMAX_API_KEY: "k" }, (m) => warned.push(m));
    expect(calls.claudeCode[0]!.options).toMatchObject({ effort: "low" });
    expect(warned).toEqual([]);
  });

  it("defaults claude-minimax to effort 'low' when no effort is requested (prevents auto-selected thinking tier)", () => {
    const { calls, factories } = recorder();
    const warned: string[] = [];
    buildAgent(factories, "claude-minimax", "x", undefined, { MINIMAX_API_KEY: "k" }, (m) => warned.push(m));
    // Always passes effort: "low" explicitly — the inner spawn must never auto-select a thinking tier.
    expect(calls.claudeCode[0]!.options).toMatchObject({ effort: "low" });
    expect(warned).toEqual([]);
  });

  it("caps 'max' to 'low' for claude-minimax — max triggers thinking which MiniMax-M3 does not accept", () => {
    const { calls, factories } = recorder();
    const warned: string[] = [];
    buildAgent(factories, "claude-minimax", "x", { effort: "max" }, { MINIMAX_API_KEY: "k" }, (m) => warned.push(m));
    expect(calls.claudeCode[0]!.options).toMatchObject({ effort: "low" });
    expect(warned.some((l) => l.includes("triggers thinking") && l.includes("'max'"))).toBe(true);
  });
});
