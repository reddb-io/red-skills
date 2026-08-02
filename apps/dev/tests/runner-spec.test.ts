import { describe, it, expect } from "vitest";
import {
  RUNNER_SPECS,
  toAgentRunner,
  runnerSupportsStructuredOutput,
  CODEX_EFFORTS,
  CLAUDE_EFFORTS,
  MINIMAX_EFFORTS,
} from "../src/core/runner-spec.js";
import type { AgentRunner } from "../src/core/execution.js";
import { runners, type Runner } from "../src/types/runner.js";
import { MINIMAX_M3_MODEL } from "@reddb-io/red-castle/engine";

describe("toAgentRunner — project the orchestrator Runner onto the provider set", () => {
  // The single source of truth for the coercion that process-issue.ts and
  // config.ts both used to copy-paste: provider-backed runners pass through,
  // every provider-less runner (today only `hermes`) collapses to `claude`.
  const cases: Array<[Runner, AgentRunner]> = [
    ["claude", "claude"],
    ["codex", "codex"],
    ["opencode", "opencode"],
    ["claude-minimax", "claude-minimax"],
    ["hermes", "claude"],
  ];

  it("covers every Runner in the union (so a new runner forces a row here)", () => {
    expect(cases.map(([r]) => r).sort()).toEqual([...runners].sort());
  });

  for (const [input, expected] of cases) {
    it(`maps '${input}' → '${expected}'`, () => {
      expect(toAgentRunner(input)).toBe(expected);
    });
  }
});

describe("RUNNER_SPECS — one row per AgentRunner (add a runner = one row)", () => {
  it("has exactly one row per AgentRunner, and each AgentRunner is its own row's identity", () => {
    expect(Object.keys(RUNNER_SPECS).sort()).toEqual(
      (["claude", "codex", "opencode", "claude-minimax"] satisfies AgentRunner[]).sort(),
    );
  });

  it("claude: effort channel, full effort union, no forced model / default effort / auth env", () => {
    const spec = RUNNER_SPECS.claude;
    expect(spec.channel).toBe("effort");
    expect(spec.efforts).toEqual(CLAUDE_EFFORTS);
    expect(spec.forcedModel).toBeUndefined();
    expect(spec.defaultEffort).toBeUndefined();
    expect(spec.resolveAuthEnv).toBeUndefined();
  });

  it("claude is the only schema-enabled runner (claude-first rollout, ADR 0090, #932)", () => {
    expect(runnerSupportsStructuredOutput("claude")).toBe(true);
    expect(runnerSupportsStructuredOutput("codex")).toBe(false);
    expect(runnerSupportsStructuredOutput("opencode")).toBe(false);
    expect(runnerSupportsStructuredOutput("claude-minimax")).toBe(false);
  });

  it("codex: effort channel, gated to CODEX_EFFORTS (no 'max')", () => {
    const spec = RUNNER_SPECS.codex;
    expect(spec.channel).toBe("effort");
    expect(spec.efforts).toEqual(CODEX_EFFORTS);
    expect(spec.efforts).not.toContain("max");
    expect(spec.forcedModel).toBeUndefined();
  });

  it("opencode: variant channel with an auth-env resolver, no effort gating in practice", () => {
    const spec = RUNNER_SPECS.opencode;
    expect(spec.channel).toBe("variant");
    expect(typeof spec.resolveAuthEnv).toBe("function");
    // OPENAI > MINIMAX > OPENROUTER precedence is owned by opencode-env.ts.
    expect(spec.resolveAuthEnv!({ OPENAI_API_KEY: "sk-oai", MINIMAX_API_KEY: "mm" })).toEqual({
      OPENAI_API_KEY: "sk-oai",
    });
    expect(spec.resolveAuthEnv!({})).toBeUndefined();
  });

  it("claude-minimax: forced MiniMax-M3 model, capped to MINIMAX_EFFORTS, defaults to 'low', MiniMax auth env", () => {
    const spec = RUNNER_SPECS["claude-minimax"];
    expect(spec.channel).toBe("effort");
    expect(spec.forcedModel).toBe(MINIMAX_M3_MODEL);
    expect(spec.efforts).toEqual(MINIMAX_EFFORTS);
    expect(spec.defaultEffort).toBe("low");
    expect(spec.resolveAuthEnv!({ MINIMAX_API_KEY: "mm-key" })).toEqual({
      ANTHROPIC_API_KEY: "mm-key",
      ANTHROPIC_BASE_URL: "https://api.minimax.io/anthropic",
      CLAUDE_CODE_SIMPLE: "1",
    });
    expect(spec.resolveAuthEnv!({})).toBeUndefined();
  });
});
