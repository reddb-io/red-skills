import { describe, expect, it } from "vitest";
import {
  BLOCKED_SIGNAL,
  CODEX_EFFORTS,
  COMPLETION_SIGNALS,
  DONE_SIGNAL,
  MINIMAX_M3_MODEL,
  MINIMAX_EFFORTS,
  NO_MORE_TASKS_SIGNAL,
  RUNNER_SPECS,
  claudeSpawnArgs,
  codexSpawnArgs,
  detectRunner,
  detectSentinelLine,
  isRunnerExhausted,
  openCodeAuthEnv,
  parseRunnerFlag,
  projectImplementerEnvironment,
  resolveMiniMaxClaudeEnv,
  resolveOpenCodeAuth,
  runnerSupportsModel,
  runnerSupportsStructuredOutput,
  toAgentRunner,
  type AgentRunner,
  type AgentStreamEvent,
  type LivenessVerdict,
  type RunResult,
} from "./index.js";
import { runners, type Runner } from "./runner-types.js";

describe("engine runner registry", () => {
  it.each([
    ["claude", {}, { plugins: ["dev"], mcp: [], rsp: false }],
    [
      "claude",
      { "plugins.memory.enabled": "true" },
      {
        plugins: ["dev", "memory"],
        mcp: ["red-memory"],
        rsp: false,
      },
    ],
    [
      "claude",
      { "plugins.brain.enabled": "true" },
      { plugins: ["dev", "brain"], mcp: ["brain"], rsp: false },
    ],
    [
      "claude",
      { "plugins.red-ui.enabled": "true" },
      { plugins: ["dev"], mcp: ["red-ui"], rsp: false },
    ],
    [
      "claude",
      { "rsp.enabled": "true" },
      { plugins: ["dev"], mcp: [], rsp: true },
    ],
    ["codex", {}, { plugins: ["dev"], mcp: [], rsp: false }],
    [
      "codex",
      { "plugins.memory.enabled": "true" },
      {
        plugins: ["dev", "memory"],
        mcp: ["red-memory"],
        rsp: false,
      },
    ],
    [
      "codex",
      { "plugins.brain.enabled": "true" },
      { plugins: ["dev", "brain"], mcp: ["brain"], rsp: false },
    ],
    [
      "codex",
      { "plugins.red-ui.enabled": "true" },
      { plugins: ["dev"], mcp: ["red-ui"], rsp: false },
    ],
    [
      "codex",
      { "rsp.enabled": "true" },
      { plugins: ["dev"], mcp: [], rsp: true },
    ],
    ["opencode", {}, { plugins: ["dev"], mcp: [], rsp: false }],
    [
      "opencode",
      { "plugins.memory.enabled": "true" },
      {
        plugins: ["dev", "memory"],
        mcp: ["red-memory"],
        rsp: false,
      },
    ],
    [
      "opencode",
      { "plugins.brain.enabled": "true" },
      { plugins: ["dev", "brain"], mcp: ["brain"], rsp: false },
    ],
    [
      "opencode",
      { "plugins.red-ui.enabled": "true" },
      { plugins: ["dev"], mcp: ["red-ui"], rsp: false },
    ],
    [
      "opencode",
      { "rsp.enabled": "true" },
      { plugins: ["dev"], mcp: [], rsp: true },
    ],
    ["pi", {}, { plugins: ["dev"], mcp: [], rsp: false }],
    [
      "pi",
      { "plugins.memory.enabled": "true" },
      {
        plugins: ["dev", "memory"],
        mcp: ["red-memory"],
        rsp: false,
      },
    ],
    [
      "pi",
      { "plugins.brain.enabled": "true" },
      { plugins: ["dev", "brain"], mcp: ["brain"], rsp: false },
    ],
    [
      "pi",
      { "plugins.red-ui.enabled": "true" },
      { plugins: ["dev"], mcp: ["red-ui"], rsp: false },
    ],
    [
      "pi",
      { "rsp.enabled": "true" },
      { plugins: ["dev"], mcp: [], rsp: true },
    ],
  ] as const)(
    "projects the exact %s implementer constraint for one activation gate",
    (runner, values, enabled) => {
      const projection = projectImplementerEnvironment(runner, values);

      expect(projection.enabled).toEqual(enabled);
      expect(projection.constraint).toMatchSnapshot();
      expect(JSON.stringify(projection)).not.toMatch(
        /statusline|hooks\/|hooks\\\\/,
      );
    },
  );

  it("owns the runner rows and provider-less projection", () => {
    const cases: Array<[Runner, AgentRunner]> = [
      ["claude", "claude"],
      ["codex", "codex"],
      ["opencode", "opencode"],
      ["claude-minimax", "claude-minimax"],
      ["hermes", "claude"],
    ];
    expect(cases.map(([r]) => r).sort()).toEqual([...runners].sort());
    for (const [input, expected] of cases)
      expect(toAgentRunner(input)).toBe(expected);
    expect(Object.keys(RUNNER_SPECS).sort()).toEqual(
      (
        [
          "claude",
          "codex",
          "opencode",
          "claude-minimax",
        ] satisfies AgentRunner[]
      ).sort(),
    );
  });

  it("keeps auth resolvers and structured-output policy in the engine unit", () => {
    expect(RUNNER_SPECS.codex.efforts).toEqual(CODEX_EFFORTS);
    expect(RUNNER_SPECS.codex.efforts).not.toContain("max");
    expect(RUNNER_SPECS["claude-minimax"].forcedModel).toBe(MINIMAX_M3_MODEL);
    expect(RUNNER_SPECS["claude-minimax"].efforts).toEqual(MINIMAX_EFFORTS);
    expect(resolveMiniMaxClaudeEnv({ MINIMAX_API_KEY: "mm-key" })).toEqual({
      ANTHROPIC_API_KEY: "mm-key",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      CLAUDE_CODE_SIMPLE: "1",
    });
    expect(
      openCodeAuthEnv(resolveOpenCodeAuth({ MINIMAX_API_KEY: "mm" })),
    ).toEqual({ MINIMAX_API_KEY: "mm" });
    expect(runnerSupportsStructuredOutput("claude")).toBe(true);
    expect(runnerSupportsStructuredOutput("codex")).toBe(false);
  });

  it("answers whether a runner's CLI can dispatch a model slug (#2352)", () => {
    expect(runnerSupportsModel("claude", "claude-opus-4-8")).toBe(true);
    expect(runnerSupportsModel("claude", "sonnet")).toBe(true);
    expect(
      runnerSupportsModel("claude", "us.anthropic.claude-opus-4-8-v1:0"),
    ).toBe(true);
    expect(runnerSupportsModel("claude", "gpt-5.6-sol")).toBe(false);
    expect(runnerSupportsModel("codex", "gpt-5.6-sol")).toBe(true);
    expect(runnerSupportsModel("codex", "o3")).toBe(true);
    expect(runnerSupportsModel("codex", "claude-opus-4-8")).toBe(false);
    expect(
      runnerSupportsModel("opencode", "openrouter/anthropic/claude-opus-4"),
    ).toBe(true);
    expect(runnerSupportsModel("opencode", "claude-opus-4-8")).toBe(false);
    // A forcedModel runner accepts exactly its forced slug.
    expect(runnerSupportsModel("claude-minimax", MINIMAX_M3_MODEL)).toBe(true);
    expect(runnerSupportsModel("claude-minimax", "claude-opus-4-8")).toBe(
      false,
    );
    // A blank slug is never runnable.
    expect(runnerSupportsModel("claude", "  ")).toBe(false);
  });

  it("keeps runner detection and spawn argv parity in the engine unit", () => {
    expect(detectRunner({ flag: "opencode" })).toMatchObject({
      runner: "opencode",
      method: "flag",
    });
    expect(
      detectRunner({ env: { CODEX_SANDBOX: "danger-full-access" } }),
    ).toMatchObject({
      runner: "codex",
      method: "env-var",
    });
    expect(
      detectRunner({ env: {}, processTree: "node /opt/opencode/bin/opencode" }),
    ).toMatchObject({
      runner: "claude",
      method: "env-fallback",
    });
    expect(parseRunnerFlag(["--runner=claude-minimax"])).toBe("claude-minimax");
    expect(claudeSpawnArgs({ prompt: "PROMPT", worktree: "/wt" }).args).toEqual(
      [
        "--model",
        "opus",
        "--effort",
        "medium",
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--print",
        "PROMPT",
      ],
    );
    expect(
      codexSpawnArgs({
        prompt: "PROMPT",
        worktree: "/wt",
        lastMessagePath: "/last",
        effort: "high",
      }).args,
    ).toContain("model_reasoning_effort=high");
    expect(isRunnerExhausted("Weekly cap reached")).toBe(true);
  });

  it("exports completion sentinels and stream/result/liveness types from the engine barrel", () => {
    expect(DONE_SIGNAL).toBe("<promise>DONE</promise>");
    expect(BLOCKED_SIGNAL).toBe("<promise>BLOCKED</promise>");
    expect(NO_MORE_TASKS_SIGNAL).toBe("<promise>NO MORE TASKS</promise>");
    expect(COMPLETION_SIGNALS).toEqual([DONE_SIGNAL, BLOCKED_SIGNAL]);
    expect(
      detectSentinelLine("x <promise>NO MORE TASKS</promise> y")?.kind,
    ).toBe("no_more_tasks");

    const _stream: AgentStreamEvent | undefined = undefined;
    const _result: RunResult | undefined = undefined;
    const _liveness: LivenessVerdict | undefined = undefined;
    expect([_stream, _result, _liveness]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });
});
