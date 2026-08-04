import { describe, it, expect } from "vitest";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRunOptions,
  buildContinuousPushHook,
  buildNoLeakCommitMsgHook,
  interpretOutcome,
  interpretCompletion,
  enforceStructuredOutput,
  isExhaustionError,
  isHostConfigRunnerError,
  isTransientRunnerError,
  extractSignalKill,
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
  DEFAULT_VITALS_SAMPLE_MS,
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
  fakeResult,
  makeDeps,
} from "./execution-test-helpers.js";
import {
  WORKER_GH_ACTOR_ENV,
  WORKER_GH_REAL_ENV,
} from "../src/runtime/worker-gh-boundary.js";

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

describe("runAgent — Worker gh boundary", () => {
  it("puts the private gh shim on the implementer's PATH before sandcastle runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "execution-worker-gh-"));
    const bin = join(root, "host-bin");
    const realGh = join(bin, "gh");
    await mkdir(bin, { recursive: true });
    await writeFile(realGh, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(realGh, 0o700);

    const saved = {
      PATH: process.env.PATH,
      real: process.env[WORKER_GH_REAL_ENV],
      actor: process.env[WORKER_GH_ACTOR_ENV],
    };
    delete process.env[WORKER_GH_REAL_ENV];
    delete process.env[WORKER_GH_ACTOR_ENV];
    process.env.PATH = bin;
    try {
      let seen: { path?: string; real?: string; actor?: string } = {};
      await runAgent(
        makeDeps(async () => {
          seen = {
            path: process.env.PATH,
            real: process.env[WORKER_GH_REAL_ENV],
            actor: process.env[WORKER_GH_ACTOR_ENV],
          };
          return fakeResult();
        }),
        { ...baseInput, cwd: root, githubBoundaryActor: "worker:wBOUND" },
      );

      expect(seen.path?.split(":")[0]).toBe(join(root, "github-boundary", "bin"));
      expect(seen.real).toBe(realGh);
      expect(seen.actor).toBe("worker:wBOUND");
    } finally {
      if (saved.PATH === undefined) delete process.env.PATH;
      else process.env.PATH = saved.PATH;
      if (saved.real === undefined) delete process.env[WORKER_GH_REAL_ENV];
      else process.env[WORKER_GH_REAL_ENV] = saved.real;
      if (saved.actor === undefined) delete process.env[WORKER_GH_ACTOR_ENV];
      else process.env[WORKER_GH_ACTOR_ENV] = saved.actor;
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("runAgent — structured-output gate (ADR 0090, #932)", () => {
  it("downgrades a claude DONE that lacks a valid AgentOutput to no-sentinel", async () => {
    const warnings: string[] = [];
    const deps = { ...makeDeps(async () => fakeResult({ stdout: "worked but no schema block" })), warn: (m: string) => warnings.push(m) };
    const r = await runAgent(deps, baseInput);
    expect(r.outcome).toBe("no-sentinel");
    expect(r.completionSignal).toBe(DONE_SIGNAL);
    expect(warnings.some((w) => w.includes("AgentOutput"))).toBe(true);
  });

  it("honours a codex DONE with no AgentOutput (non-schema runner keeps the sentinel)", async () => {
    const r = await runAgent(makeDeps(async () => fakeResult({ stdout: "no schema block" })), {
      ...baseInput,
      runner: "codex",
      model: "gpt-5.4",
    });
    expect(r.outcome).toBe("done");
  });
});

describe("runAgent — independent worker-vitals sampler (ADR 0103)", () => {
  // Captures the single scheduled fn so the test pumps ticks by hand.
  function manualScheduler() {
    let fn: (() => void) | undefined;
    return {
      schedule: (f: () => void, _ms: number) => {
        fn = f;
        return () => {
          fn = undefined;
        };
      },
      tick: () => fn?.(),
      armed: () => fn !== undefined,
    };
  }
  function fakeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
  };

  it("stamps vitals on its own cadence for a quiet codex run with no guard in the engine", async () => {
    // The exact fleet repro: a codex worker that emits no stream events (blocked
    // waiting on a test suite). Before the ADR 0103 sampler, BOTH heartbeat paths
    // hung off headProbe + attempt-guard arming, so `emitHeartbeat` never fired
    // and loc/tokens sat at +0 -0. The guard is now gone entirely, which makes
    // this sampler the ONLY unconditional vitals driver — the regression this
    // slice must not reintroduce.
    const heartbeats: AttemptProgressInfo[] = [];
    const sched = manualScheduler();
    const clock = fakeClock();
    let releaseRun: () => void = () => {};
    const runGate = new Promise<void>((res) => {
      releaseRun = res;
    });
    const deps = {
      ...makeDeps(async () => {
        await runGate;
        return fakeResult();
      }),
      schedule: sched.schedule,
      now: clock.now,
    };
    const runP = runAgent(deps, {
      ...baseInput,
      runner: "codex",
      model: "gpt-5.4",
      headProbe: async () => "deadbeef",
      onHeartbeat: (info) => heartbeats.push(info),
    });
    await flush();
    expect(sched.armed()).toBe(true); // the sampler armed itself
    expect(heartbeats).toHaveLength(0); // nothing before the first sample window

    clock.advance(DEFAULT_VITALS_SAMPLE_MS);
    sched.tick();
    await flush();

    expect(heartbeats.length).toBeGreaterThan(0);
    expect(heartbeats[0]?.head).toBe("deadbeef");

    releaseRun();
    await runP;
  });

  it("does not arm the sampler when there is no heartbeat sink", async () => {
    const sched = manualScheduler();
    const deps = { ...makeDeps(async () => fakeResult()), schedule: sched.schedule, now: fakeClock().now };
    await runAgent(deps, { ...baseInput, runner: "codex", model: "gpt-5.4" });
    expect(sched.armed()).toBe(false);
  });

  it("cancels the sampler once the run completes", async () => {
    const sched = manualScheduler();
    const deps = { ...makeDeps(async () => fakeResult()), schedule: sched.schedule, now: fakeClock().now };
    await runAgent(deps, {
      ...baseInput,
      runner: "codex",
      model: "gpt-5.4",
      headProbe: async () => "sha",
      onHeartbeat: () => {},
    });
    // The finally block called the sampler's cancel, clearing the captured fn.
    expect(sched.armed()).toBe(false);
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
  });

  it("excludes permanent missing-interpreter and missing-cwd host defects", () => {
    expect(isTransientRunnerError(new Error("exec failed: exec failed: spawn sh ENOENT"))).toBe(false);
    expect(isTransientRunnerError(new Error("cwd does not exist: /tmp/worker-attempt"))).toBe(false);
  });

  it("matches a gitconfig lock collision during sandbox setup — infra-transient, never a no-sentinel death (#2494)", () => {
    expect(
      isTransientRunnerError(
        new Error('Command failed (exit 255): git config --global --add safe.directory "x"\nerror: could not lock config file /home/user/.gitconfig: File exists'),
      ),
    ).toBe(true);
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

describe("runAgent — fatal host configuration", () => {
  it.each([
    "exec failed: exec failed: spawn sh ENOENT",
    "cwd does not exist: /tmp/worker-attempt",
  ])("maps %s to one actionable host-config outcome", async (message) => {
    let invocations = 0;
    const error = new Error(message);
    expect(isHostConfigRunnerError(error)).toBe(true);

    const r = await runAgent(
      makeDeps(async () => {
        invocations += 1;
        throw error;
      }),
      baseInput,
    );

    expect(invocations).toBe(1);
    expect(r.outcome).toBe("host-config");
    expect(r.commits).toEqual([]);
    expect(r.stdout).toContain("fatal host configuration");
    expect(r.stdout).toContain("not retryable");
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

describe("runAgent — unclassified runner error never crashes the drain (#767)", () => {
  it("maps any other thrown error to no-sentinel (recoverable crash), not a rethrow", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("some unrecognized runner failure nobody has a pattern for yet");
      }),
      baseInput,
    );
    expect(r.outcome).toBe("no-sentinel");
    expect(r.stdout).toContain("unrecognized runner failure");
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

  it("maps a non-exhaustion, non-transient error to no-sentinel (never rethrows — #767)", async () => {
    // Previously this rethrew, killing the orchestrator + orphaning the issue
    // in `running`. Now any unclassified runner error becomes a recoverable
    // no-sentinel crash so the drain survives.
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("worktree add failed: fatal");
      }),
      baseInput,
    );
    expect(r.outcome).toBe("no-sentinel");
    expect(r.stdout).toContain("worktree add failed");
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

// ---- claude-minimax exhaustion detection (#793) ----
//
// MiniMax's Anthropic-compat endpoint (https://api.minimax.io/anthropic) was
// validated in the spike gate (#790) but no quota hit was observed during the
// probe. These tests document the expected error shapes based on the
// Anthropic-compat error format that MiniMax's endpoint implements, plus the
// HTTP 429 numeric code that Claude Code CLI surfaces when the endpoint returns
// a rate-limit response without a parseable error body.

describe("isExhaustionError — claude-minimax MiniMax Anthropic-compat shapes (#793)", () => {
  it("matches a bare HTTP 429 status code string (MiniMax rate-limit via Claude Code)", () => {
    expect(isExhaustionError(new Error("API Error: 429 Too Many Requests"))).toBe(true);
    expect(isExhaustionError(new Error("HTTP error: 429"))).toBe(true);
    expect(isExhaustionError("claude-code exited with status 429")).toBe(true);
  });

  it("matches a MiniMax Anthropic-compat rate_limit_error body (Anthropic format)", () => {
    expect(
      isExhaustionError(new Error('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded, please retry."}}')),
    ).toBe(true);
  });

  it("matches rate_limit_error nested under a cause chain (Effect-style sandcastle error)", () => {
    expect(
      isExhaustionError({
        message: "agent failed",
        cause: { message: '{"type":"error","error":{"type":"rate_limit_error"}}' },
      }),
    ).toBe(true);
  });

  it("matches insufficient credits / balance (HTTP 402 variant)", () => {
    expect(isExhaustionError(new Error("API Error: insufficient credits to complete this request"))).toBe(true);
    expect(isExhaustionError(new Error("insufficient credit: please top up your MiniMax account"))).toBe(true);
  });

  it("matches MiniMax balance-depletion strings (Insufficient balance / balance insufficient)", () => {
    expect(isExhaustionError(new Error("Insufficient balance"))).toBe(true);
    expect(isExhaustionError(new Error("balance insufficient for this request"))).toBe(true);
  });

  it("does not match 4290 (word-boundary guard on 429)", () => {
    expect(isExhaustionError(new Error("processed 4290 records"))).toBe(false);
  });
});

describe("isTransientRunnerError — network transport errors for claude-minimax (#793)", () => {
  it("matches ECONNREFUSED (MiniMax endpoint unreachable)", () => {
    expect(isTransientRunnerError(new Error("connect ECONNREFUSED 1.2.3.4:443"))).toBe(true);
    expect(isTransientRunnerError(new Error("request to https://api.minimax.io/anthropic failed: ECONNREFUSED"))).toBe(true);
  });

  it("matches ENOTFOUND (DNS lookup failure for api.minimax.io)", () => {
    expect(isTransientRunnerError(new Error("getaddrinfo ENOTFOUND api.minimax.io"))).toBe(true);
  });

  it("matches ETIMEDOUT / ECONNRESET (connection timeout or reset)", () => {
    expect(isTransientRunnerError(new Error("connect ETIMEDOUT 1.2.3.4:443"))).toBe(true);
    expect(isTransientRunnerError(new Error("socket hang up: ECONNRESET"))).toBe(true);
  });

  it("does not match ordinary agent/work failures", () => {
    expect(isTransientRunnerError(new Error("tests failed: 2 failing"))).toBe(false);
    expect(isTransientRunnerError(new Error("worktree add failed: fatal"))).toBe(false);
  });
});

describe("runAgent — claude-minimax exhaustion (HTTP 429 from MiniMax endpoint)", () => {
  it("maps a thrown HTTP 429 error to the exhausted outcome", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("claude-code exited with code 1: API Error: 429 Too Many Requests");
      }),
      { ...baseInput, runner: "claude-minimax", model: "MiniMax-M3" },
    );
    expect(r.outcome).toBe("exhausted");
    expect(r.commits).toEqual([]);
    expect(r.completionSignal).toBeUndefined();
  });

  it("maps exhaustion text on stdout (rate_limit_error body, no completion signal) to exhausted", async () => {
    const r = await runAgent(
      makeDeps(async () =>
        fakeResult({
          completionSignal: undefined,
          stdout: '{"type":"error","error":{"type":"rate_limit_error","message":"quota reached"}}',
        }),
      ),
      { ...baseInput, runner: "claude-minimax", model: "MiniMax-M3" },
    );
    expect(r.outcome).toBe("exhausted");
  });

  it("maps a thrown balance-depletion error to the exhausted outcome", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("claude-code exited with code 1: Insufficient balance");
      }),
      { ...baseInput, runner: "claude-minimax", model: "MiniMax-M3" },
    );
    expect(r.outcome).toBe("exhausted");
  });
});

describe("runAgent — claude-minimax transient transport failure (ECONNREFUSED)", () => {
  it("maps a thrown ECONNREFUSED to runner-transient, not a crash", async () => {
    const r = await runAgent(
      makeDeps(async () => {
        throw new Error("request to https://api.minimax.io/anthropic/v1/messages failed: ECONNREFUSED");
      }),
      { ...baseInput, runner: "claude-minimax", model: "MiniMax-M3" },
    );
    expect(r.outcome).toBe("runner-transient");
    expect(r.commits).toEqual([]);
    expect(r.stdout).toContain("ECONNREFUSED");
  });
});

// ---- attempt progress guard (proof-of-progress, PR-A) ----
