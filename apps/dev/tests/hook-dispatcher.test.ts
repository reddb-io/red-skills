import { describe, expect, it } from "vitest";
import {
  resolveHooks,
  type HookDefaultName,
  type ResolvedHooks,
} from "../src/core/hook-config.js";
import {
  deriveHookEnv,
  dispatchHooks,
  HOOK_EXIT_POLICY,
  UnknownLifecyclePointError,
  type HookExec,
  type HookExecution,
} from "../src/core/hook-dispatcher.js";

/**
 * Tests for hook-dispatcher.ts — the pure dispatch of one lifecycle point's
 * resolved command list under the interceptor contract and exit-code policy.
 * Ported from scripts/tests/hook-dispatcher.test.sh, keeping the meaningful
 * cases: empty-stdout (unchanged), JSON-stdout (replace), non-JSON (parse
 * failure per policy), pre_* abort, post_* continue, defaults-then-user
 * ordering, and the executions list shape.
 *
 * All command execution flows through an injected fake `HookExec` — no real
 * subprocess is spawned. Each fake maps a command string to a scripted
 * `{ code, stdout }`, so the policy/chain logic is exercised in isolation.
 */

/**
 * Build a fake executor from a per-command script. An unscripted command
 * defaults to a clean no-op (rc=0, empty stdout — context unchanged), which
 * matches a pure side-effect hook.
 */
function fakeExec(
  script: Record<string, { code?: number; stdout?: string }>,
  calls?: Array<{ command: string; stdin: string; env: Record<string, string> }>,
): HookExec {
  return async (command, env, stdin) => {
    calls?.push({ command, stdin, env });
    const entry = script[command] ?? {};
    return { code: entry.code ?? 0, stdout: entry.stdout ?? "" };
  };
}

const DEFAULT_CMDS: Record<HookDefaultName, string> = {
  cargo: "defaults/cargo-pre-worktree.sh",
  gradle: "defaults/gradle-pre-worktree.sh",
  heartbeat: "defaults/heartbeat-post-attempt.sh",
  envelope: "defaults/envelope-post-attempt.sh",
  validation: "defaults/validation-post-merge.sh",
};

function resolve(config: Record<string, string>): ResolvedHooks {
  return resolveHooks(config, { defaultCommand: (name) => DEFAULT_CMDS[name] });
}

describe("hook-dispatcher exit-code policy table", () => {
  it("matches the shell HOOK_EXIT_POLICY exactly", () => {
    expect(HOOK_EXIT_POLICY).toEqual({
      pre_session: "abort",
      pre_pick: "abort",
      post_pick: "continue",
      pre_worktree: "abort",
      pre_attempt: "abort",
      post_attempt: "continue",
      pre_feedback: "abort",
      on_baseline_probe: "continue",
      post_feedback: "continue",
      pre_merge: "abort",
      post_merge: "continue",
      on_attempt_error: "continue",
      on_recovery_decision: "continue",
      on_blocked: "continue",
      on_reconcile: "continue",
      on_idle: "continue",
      on_heartbeat: "continue",
      post_session: "continue",
      on_session_error: "continue",
    });
  });
});

describe("hook-dispatcher interceptor contract", () => {
  it("returns context unchanged for an empty command list", async () => {
    const result = await dispatchHooks(
      "pre_session",
      [],
      '{"runner":"claude"}',
      fakeExec({}),
    );
    expect(result.context).toBe('{"runner":"claude"}');
    expect(result.aborted).toBe(false);
    expect(result.rc).toBe(0);
    expect(result.executions).toEqual([]);
  });

  it("leaves context unchanged when a command writes empty stdout", async () => {
    const result = await dispatchHooks(
      "pre_session",
      ["true"],
      '{"runner":"codex"}',
      fakeExec({ true: { code: 0, stdout: "" } }),
    );
    expect(result.context).toBe('{"runner":"codex"}');
    expect(result.aborted).toBe(false);
  });

  it("replaces context when a command writes a JSON object", async () => {
    const result = await dispatchHooks(
      "pre_session",
      ["emit"],
      '{"runner":"claude"}',
      fakeExec({ emit: { code: 0, stdout: '{"runner":"hermes"}' } }),
    );
    expect(result.context).toBe('{"runner":"hermes"}');
    expect(result.aborted).toBe(false);
  });

  it("threads the mutated context through the chain in order", async () => {
    const calls: Array<{ command: string; stdin: string; env: Record<string, string> }> = [];
    const result = await dispatchHooks(
      "pre_session",
      ["first", "second"],
      "{}",
      fakeExec(
        {
          first: { code: 0, stdout: '{"n":1}' },
          second: { code: 0, stdout: '{"n":11}' },
        },
        calls,
      ),
      {},
    );
    // The second command sees the first's output on stdin.
    expect(calls[0]!.stdin).toBe("{}");
    expect(calls[1]!.stdin).toBe('{"n":1}');
    expect(result.context).toBe('{"n":11}');
  });

  it("trims surrounding whitespace before the JSON-object check", async () => {
    const result = await dispatchHooks(
      "pre_session",
      ["emit"],
      "{}",
      fakeExec({ emit: { code: 0, stdout: '\n  {"ok":true}  \n' } }),
    );
    expect(result.context).toBe('{"ok":true}');
  });
});

describe("hook-dispatcher non-JSON stdout (parse failure)", () => {
  it("aborts under a pre_* policy and propagates rc=65", async () => {
    const result = await dispatchHooks(
      "pre_session",
      ["bad"],
      "{}",
      fakeExec({ bad: { code: 0, stdout: "not json" } }),
    );
    expect(result.aborted).toBe(true);
    expect(result.rc).toBe(65);
    // context is left at the last good value
    expect(result.context).toBe("{}");
  });

  it("treats a JSON array stdout as a parse failure (must be an object)", async () => {
    const result = await dispatchHooks(
      "pre_session",
      ["arr"],
      "{}",
      fakeExec({ arr: { code: 0, stdout: "[1,2,3]" } }),
    );
    expect(result.aborted).toBe(true);
    expect(result.rc).toBe(65);
  });

  it("logs and continues under a post_* policy, applying later commands", async () => {
    const result = await dispatchHooks(
      "post_session",
      ["bad", "good"],
      '{"orig":1}',
      fakeExec({
        bad: { code: 0, stdout: "still not json" },
        good: { code: 0, stdout: '{"x":1}' },
      }),
    );
    expect(result.aborted).toBe(false);
    expect(result.rc).toBe(0);
    expect(result.context).toBe('{"x":1}');
  });
});

describe("hook-dispatcher exit-code policy", () => {
  it("aborts the chain on a pre_* non-zero exit and skips later commands", async () => {
    const calls: Array<{ command: string; stdin: string; env: Record<string, string> }> = [];
    const result = await dispatchHooks(
      "pre_session",
      ["boom", "after"],
      "{}",
      fakeExec(
        {
          boom: { code: 7, stdout: "" },
          after: { code: 0, stdout: '{"reached":true}' },
        },
        calls,
      ),
    );
    expect(result.aborted).toBe(true);
    expect(result.rc).toBe(7);
    // the second command must never have run
    expect(calls.map((c) => c.command)).toEqual(["boom"]);
    expect(result.executions.map((e) => e.command)).toEqual(["boom"]);
  });

  it("logs and continues on a post_* non-zero exit, running later commands", async () => {
    const result = await dispatchHooks(
      "post_session",
      ["boom", "after"],
      "{}",
      fakeExec({
        boom: { code: 9, stdout: "" },
        after: { code: 0, stdout: '{"after_fail":true}' },
      }),
    );
    expect(result.aborted).toBe(false);
    expect(result.rc).toBe(0);
    expect(result.context).toBe('{"after_fail":true}');
  });
});

describe("hook-dispatcher unknown lifecycle point", () => {
  it("throws UnknownLifecyclePointError on a non-canonical name", async () => {
    await expect(
      // deliberately pass a name outside the canonical set
      dispatchHooks("pre_doesnotexist" as never, ["x"], "{}", fakeExec({})),
    ).rejects.toThrow(/unknown lifecycle point 'pre_doesnotexist'/);
  });
});

describe("hook-dispatcher composes resolveHooks (defaults-then-user order)", () => {
  it("dispatches built-in defaults first, then user-declared commands", async () => {
    const resolved = resolve({
      "afk.hooks.pre_worktree": ["echo user-a", "echo user-b"].join("\n"),
    });
    const calls: Array<{ command: string; stdin: string; env: Record<string, string> }> = [];
    const result = await dispatchHooks(
      "pre_worktree",
      resolved.pre_worktree,
      "{}",
      fakeExec({}, calls),
    );
    expect(calls.map((c) => c.command)).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
      "echo user-a",
      "echo user-b",
    ]);
    expect(result.executions.map((e) => e.command)).toEqual([
      DEFAULT_CMDS.cargo,
      DEFAULT_CMDS.gradle,
      "echo user-a",
      "echo user-b",
    ]);
  });
});

describe("hook-dispatcher executions list shape", () => {
  it("records {name, command, rc} per executed command, in order", async () => {
    const result = await dispatchHooks(
      "post_session",
      ["a", "b", "c"],
      "{}",
      fakeExec({
        a: { code: 0, stdout: "" },
        b: { code: 3, stdout: "" },
        c: { code: 0, stdout: '{"done":true}' },
      }),
    );
    const expected: HookExecution[] = [
      { name: "post_session", command: "a", rc: 0 },
      { name: "post_session", command: "b", rc: 3 },
      { name: "post_session", command: "c", rc: 0 },
    ];
    expect(result.executions).toEqual(expected);
    // a non-zero exit under a continue policy is still recorded, not hidden
    expect(result.executions[1]!.rc).toBe(3);
  });

  it("logs hook enter and exit for successful commands", async () => {
    const logs: string[] = [];
    await dispatchHooks("post_session", ["notify"], "{}", fakeExec({ notify: { code: 0 } }), {
      log: (line) => logs.push(line),
    });
    expect(logs).toEqual([
      "[afk:hooks] post_session: enter: notify",
      "[afk:hooks] post_session: exit rc=0: notify",
    ]);
  });

  it("passes the documented env to every command", async () => {
    const calls: Array<{ command: string; stdin: string; env: Record<string, string> }> = [];
    await dispatchHooks(
      "pre_session",
      ["a"],
      "{}",
      fakeExec({}, calls),
      { env: { RED_AFK_RUNNER: "claude" } },
    );
    expect(calls[0]!.env).toEqual({ RED_AFK_RUNNER: "claude" });
  });
});

describe("deriveHookEnv (documented per-event RED_AFK_* contract)", () => {
  const base = { RED_AFK_REPO: "owner/repo", RED_AFK_ROOT: "/repo", RED_AFK_WORKSPACE: "/repo" };

  it("returns the base env unchanged for empty and non-object contexts", () => {
    expect(deriveHookEnv(base, "{}")).toEqual(base);
    expect(deriveHookEnv(base, "[]")).toEqual(base);
    expect(deriveHookEnv(base, "not json")).toEqual(base);
  });

  it("derives the pre_attempt env from issue, workspace, and runner", () => {
    const env = deriveHookEnv(
      base,
      JSON.stringify({
        issue: { number: 585, title: "fix env contract" },
        workspace: "/repo/.red/tmp/worktree",
        runner: "codex",
        attempt_n: 2,
      }),
    );

    expect(env).toEqual({
      RED_AFK_REPO: "owner/repo",
      RED_AFK_ROOT: "/repo",
      RED_AFK_WORKSPACE: "/repo/.red/tmp/worktree",
      RED_AFK_ISSUE: "585",
      RED_AFK_RUNNER: "codex",
    });
  });

  it("derives result, error, and merge vars when those event fields are present", () => {
    const env = deriveHookEnv(
      base,
      JSON.stringify({
        issue: { number: 7 },
        result: { status: "success", outcome: "done" },
        error: { class: "session-crash", message: "boom" },
        merge_base: "main",
        merge_commit: { sha: "abc123456", short: "abc1234" },
        attempt_n: 1,
      }),
    );

    expect(env.RED_AFK_ISSUE).toBe("7");
    expect(env.RED_AFK_RESULT_STATUS).toBe("success");
    expect(env.RED_AFK_RESULT_OUTCOME).toBe("done");
    expect(env.RED_AFK_ERROR_CLASS).toBe("session-crash");
    expect(env.RED_AFK_ERROR_MESSAGE).toBe("boom");
    expect(env.RED_AFK_MERGE_BASE).toBe("main");
    expect(env.RED_AFK_MERGE_COMMIT).toBe("abc123456");
    expect(env.RED_AFK_MERGE_SHA).toBe("abc1234");
    expect("RED_AFK_ATTEMPT_N" in env).toBe(false);
  });

  it("leaves irrelevant or empty fields unset", () => {
    const env = deriveHookEnv(base, JSON.stringify({ result: { status: "fail", outcome: "" } }));

    expect(env.RED_AFK_RESULT_STATUS).toBe("fail");
    expect("RED_AFK_RESULT_OUTCOME" in env).toBe(false);
    expect("RED_AFK_ISSUE" in env).toBe(false);
    expect("RED_AFK_RUNNER" in env).toBe(false);
  });

  it("derives RED_AFK_ITER_LOG and RED_AFK_STATE_FILE from the post_attempt context", () => {
    const env = deriveHookEnv(
      base,
      JSON.stringify({
        issue: { number: 42 },
        workspace: "/wt",
        result: { status: "success", outcome: "done" },
        attempt_n: 1,
        iter_log: "/repo/.red/tmp/workers/w0/42-1/afk.log",
        state_file: "/repo/.red/tmp/workers/w0/42-1/afk.state.toon",
      }),
    );

    expect(env.RED_AFK_ITER_LOG).toBe("/repo/.red/tmp/workers/w0/42-1/afk.log");
    expect(env.RED_AFK_STATE_FILE).toBe("/repo/.red/tmp/workers/w0/42-1/afk.state.toon");
  });

  it("leaves RED_AFK_ITER_LOG and RED_AFK_STATE_FILE unset when absent from context", () => {
    const env = deriveHookEnv(base, JSON.stringify({ result: { status: "fail", outcome: "" } }));

    expect("RED_AFK_ITER_LOG" in env).toBe(false);
    expect("RED_AFK_STATE_FILE" in env).toBe(false);
  });

  it("derives the #832 recovery/feedback decision vars from their contexts", () => {
    expect(
      deriveHookEnv(base, JSON.stringify({ issue: { number: 1 }, decision: "escalate", reason: "stalled" }))
        .RED_AFK_RECOVERY_DECISION,
    ).toBe("escalate");
    expect(deriveHookEnv(base, JSON.stringify({ blocked_label: "blocked:policy" })).RED_AFK_BLOCKED_LABEL).toBe(
      "blocked:policy",
    );
    expect("RED_AFK_FEEDBACK_CLASS" in deriveHookEnv(base, JSON.stringify({ class: "infra" }))).toBe(false);
    expect(deriveHookEnv(base, JSON.stringify({ outcome: "landed" })).RED_AFK_RECONCILE_OUTCOME).toBe("landed");
  });

  it("flattens the on_heartbeat vitals object into RED_AFK_VITAL_* env (ADR 0065/#832)", () => {
    const env = deriveHookEnv(
      base,
      JSON.stringify({
        issue: { number: 9 },
        vitals: {
          tools_called_count: 7,
          reasoning_tokens: 128,
          loc_added: 40,
          cost_usd: 0.5,
          // A non-numeric vital is ignored (only finite numbers are surfaced).
          last_commit_at: "2026-06-22T00:00:00Z",
        },
      }),
    );

    expect(env.RED_AFK_VITAL_TOOLS_CALLED_COUNT).toBe("7");
    expect(env.RED_AFK_VITAL_REASONING_TOKENS).toBe("128");
    expect(env.RED_AFK_VITAL_LOC_ADDED).toBe("40");
    expect(env.RED_AFK_VITAL_COST_USD).toBe("0.5");
    expect("RED_AFK_VITAL_LAST_COMMIT_AT" in env).toBe(false);
  });
});

describe("dispatchHooks layers the per-event env onto the base env", () => {
  it("a pre_attempt command receives the documented RED_AFK_* vars for its event", async () => {
    const calls: Array<{ command: string; stdin: string; env: Record<string, string> }> = [];
    await dispatchHooks(
      "pre_attempt",
      ["notify"],
      JSON.stringify({ issue: { number: 585 }, workspace: "/wt", runner: "codex", attempt_n: 1 }),
      fakeExec({ notify: { code: 0, stdout: "" } }, calls),
      { env: { RED_AFK_REPO: "o/r", RED_AFK_ROOT: "/repo", RED_AFK_WORKSPACE: "/repo" } },
    );

    expect(calls[0]!.env).toEqual({
      RED_AFK_REPO: "o/r",
      RED_AFK_ROOT: "/repo",
      RED_AFK_WORKSPACE: "/wt",
      RED_AFK_ISSUE: "585",
      RED_AFK_RUNNER: "codex",
    });
  });
});

it("exposes UnknownLifecyclePointError as a named export", () => {
  expect(new UnknownLifecyclePointError("x").name).toBe("UnknownLifecyclePointError");
});
