// #4031 deleted the `route-model-tier` CLI command with the rest of the dev
// router (ADR 0147 §1). The POLICY it wrapped lives on in
// `core/model-tier-route.ts` and keeps every assertion below; what left with the
// command are the cases that drove it through a fake stdin and rendered its
// Claude decision — a surface that no longer exists to test.
import { describe, expect, it } from "vitest";
import { loadConfig, type ConfigValues } from "../src/core/config.js";
import {
  modelFamily,
  routeModelTier,
  TIER_AGENT_TIERS,
  type PreToolUseInput,
} from "../src/core/model-tier-route.js";
import type { ModelTierBanditAdvice } from "@reddb-io/brain-store/model-tier-bandit.js";

/** Config with all defaults (no `.red/config.yaml` present). */
const defaults = (): ConfigValues => loadConfig("/nope", { ignoreActivationGate: true, read: () => undefined, warn: () => {} });

/** Config overriding the simple tier's Claude model (single-source check). */
const withSimpleOverride = (model: string): ConfigValues =>
  loadConfig("/cfg", { ignoreActivationGate: true,
    read: () => `plugins:\n  dev:\n    afk:\n      models:\n        claude:\n          simple:\n            model: ${model}\n`,
    warn: () => {},
  });

const task = (tool_input: Record<string, unknown>): PreToolUseInput => ({
  tool_name: "Task",
  tool_input,
});

const banditAdvice = {
  source: "brain.model-tier-bandit",
  taskClass: "bugfix",
  recommendedTier: "complex",
  confidence: 0.2,
  posterior: [
    {
      tier: "complex",
      alpha: 3,
      beta: 1,
      mean: 0.75,
      observations: 2,
      successes: 2,
      failures: 0,
      consecutiveFailures: 0,
      sample: 0.75,
    },
    {
      tier: "validate",
      alpha: 2,
      beta: 2,
      mean: 0.5,
      observations: 2,
      successes: 1,
      failures: 1,
      consecutiveFailures: 1,
      sample: 0.5,
    },
  ],
  explanation: "brain bandit advice for 'bugfix': complex posterior alpha=3, beta=1, mean=0.75.",
} satisfies ModelTierBanditAdvice;

describe("modelFamily", () => {
  it("extracts the family from full ids and aliases", () => {
    expect(modelFamily("claude-haiku-4-5")).toBe("haiku");
    expect(modelFamily("claude-sonnet-4-6")).toBe("sonnet");
    expect(modelFamily("claude-opus-4-8")).toBe("opus");
    expect(modelFamily("opus")).toBe("opus");
  });
  it("returns undefined for unknown / absent models", () => {
    expect(modelFamily("gpt-5.5")).toBeUndefined();
    expect(modelFamily(undefined)).toBeUndefined();
    expect(modelFamily("")).toBeUndefined();
  });
});

describe("routeModelTier — scope", () => {
  it("no-ops on non-subagent tools", () => {
    expect(routeModelTier({ tool_name: "Bash", tool_input: { command: "ls" } }, defaults())).toEqual({
      kind: "noop",
    });
  });
  it("no-ops on dispatches to non-tier subagents", () => {
    expect(routeModelTier(task({ subagent_type: "general-purpose", model: "haiku" }), defaults())).toEqual(
      { kind: "noop" },
    );
  });
  it("no-ops when the dispatch is already on the correct family (alias)", () => {
    // complex-code → complex tier → opus; a bare `opus` alias is already correct.
    expect(routeModelTier(task({ subagent_type: "complex-code", model: "opus" }), defaults())).toEqual({
      kind: "noop",
    });
  });
  it("maps every tier-agent to its tier", () => {
    expect(TIER_AGENT_TIERS).toEqual({
      validate: "validate",
      "simple-code": "simple",
      "complex-code": "complex",
    });
  });
});

describe("routeModelTier — rewrite (path a)", () => {
  it("clamps a mis-tiered validate dispatch to the maintainer-pinned model", () => {
    const action = routeModelTier(task({ subagent_type: "validate", model: "haiku", prompt: "p" }), defaults());
    expect(action.kind).toBe("rewrite");
    if (action.kind !== "rewrite") return;
    expect(action.tier).toBe("validate");
    expect(action.model).toBe("claude-opus-5");
    expect(action.effort).toBe("high");
    // full input preserved, model and effort overridden
    expect(action.updatedInput).toEqual({ subagent_type: "validate", model: "claude-opus-5", prompt: "p", effort: "high" });
  });

  it("injects the config model when a tier-agent dispatch leaves model unset", () => {
    const action = routeModelTier(task({ subagent_type: "simple-code", prompt: "p" }), defaults());
    expect(action.kind).toBe("rewrite");
    if (action.kind !== "rewrite") return;
    expect(action.model).toBe("claude-opus-5");
    expect(action.updatedInput.model).toBe("claude-opus-5");
  });

  it("applies the same maintainer pin to simple-code", () => {
    const action = routeModelTier(task({ subagent_type: "simple-code", model: "haiku" }), defaults());
    expect(action.kind === "rewrite" && action.model).toBe("claude-opus-5");
  });
});

describe("routeModelTier — explicit pin vs legacy scalar", () => {
  it("does not upgrade a correctly-cheap dispatch when an explicit tier pin equals the default", () => {
    // validate tier default = claude-opus-5; legacy afk.model = claude-sonnet-4-6.
    // An explicit validate.model = claude-opus-5 must beat the legacy scalar.
    const config = loadConfig("/x/.red/config.yaml", { ignoreActivationGate: true,
      read: () =>
        "afk:\n  model: claude-sonnet-4-6\n  models:\n    claude:\n      validate:\n        model: claude-opus-5\n",
    });
    expect(routeModelTier(task({ subagent_type: "validate", model: "opus" }), config)).toEqual({ kind: "noop" });
  });

  it("enforces the resolved effort in updatedInput alongside the model", () => {
    const action = routeModelTier(task({ subagent_type: "validate", model: "haiku" }), defaults());
    expect(action.kind).toBe("rewrite");
    if (action.kind !== "rewrite") return;
    expect(action.updatedInput).toMatchObject({ effort: "high" });
  });
});

describe("routeModelTier — single config source", () => {
  it("routes to the config-overridden model, never a hardcoded id", () => {
    const action = routeModelTier(
      task({ subagent_type: "simple-code", model: "opus" }),
      withSimpleOverride("claude-haiku-4-5"),
    );
    // override moves the simple tier to a haiku-family model; opus now mismatches.
    expect(action.kind).toBe("rewrite");
    if (action.kind !== "rewrite") return;
    expect(action.model).toBe("claude-haiku-4-5");
  });
});

describe("routeModelTier — capability degrade ladder", () => {
  it("blocks (deny-and-retry) when the host can only decide", () => {
    const action = routeModelTier(task({ subagent_type: "validate", model: "haiku" }), defaults(), "block");
    expect(action.kind).toBe("block");
    if (action.kind !== "block") return;
    expect(action.model).toBe("claude-opus-5");
  });
  it("audits (allow + nudge) when the host can neither rewrite nor block", () => {
    const action = routeModelTier(task({ subagent_type: "validate", model: "haiku" }), defaults(), "audit");
    expect(action.kind).toBe("audit");
  });
});

describe("routeModelTier — bandit advice", () => {
  it("surfaces a brain bandit recommendation without changing a correctly-tiered route", () => {
    const action = routeModelTier(
      task({ subagent_type: "validate", model: "opus" }),
      defaults(),
      "rewrite",
      { advice: banditAdvice },
    );

    expect(action).toEqual({ kind: "noop", advice: banditAdvice });
  });

  it("adopts the brain bandit recommendation only when explicitly requested", () => {
    const action = routeModelTier(
      task({ subagent_type: "validate", model: "haiku", prompt: "p" }),
      defaults(),
      "rewrite",
      { advice: banditAdvice, adoptAdvice: true },
    );

    expect(action.kind).toBe("rewrite");
    if (action.kind !== "rewrite") return;
    expect(action.tier).toBe("complex");
    expect(action.model).toBe("claude-opus-5");
    expect(action.advice).toBe(banditAdvice);
    expect(action.updatedInput).toMatchObject({
      subagent_type: "validate",
      model: "claude-opus-5",
      effort: "high",
    });
  });
});

