// core/model-tier-route.ts — the pure decision half of the interactive
// model-tier routing hook (issue #456, ADR 0049).
//
// A Claude Code / Codex PreToolUse hook fires on every subagent dispatch (the
// `Task` / `Agent` tool). This module decides, deterministically, whether the
// dispatch is mis-tiered and how to correct it — it never reads stdin, the
// filesystem, or the host; the IO half lives in commands/route-model-tier.ts.
//
// Enforcement contract (HITL 2026-06-08): (a) REWRITE the dispatch model where
// the host supports it → (b) fallback BLOCK-and-retry → (c) degrade to AUDIT.
// Claude Code PreToolUse hooks can rewrite a dispatch via
// `hookSpecificOutput.updatedInput`, so the Claude surface always takes path
// (a). The block/audit ladder is encoded here as `RouteAction` variants so a
// capability-limited host (Codex, pending #457) can degrade safely without a
// second copy of this logic.
//
// Single source of truth: the tier→model mapping is read from the same
// `.red/config.yaml` (`plugins.dev.afk.models.claude.<tier>.model`, ADR 0042)
// that sandcastle (`resolveTier`) and the model-tier-policy skill use. This
// module hardcodes NO model ids — it only maps a tier-agent's `subagent_type`
// to its config tier and asks `resolveTier` for the model.

import { resolveTier, type AfkModelTier, type ConfigValues } from "./config.js";
import type { AgentEffort } from "./execution.js";

/**
 * The three Claude tier-agents (#453) and the config tier each one pins.
 * A dispatch to one of these subagent types is the enforcement surface: its
 * model must match the tier the agent represents. Dispatches to any other
 * subagent type (general-purpose, Explore, Plan, …) are left untouched — the
 * hook cannot semantically classify an arbitrary task, only enforce the tier a
 * tier-agent already declares.
 */
export const TIER_AGENT_TIERS: Readonly<Record<string, AfkModelTier>> = {
  validate: "validate",
  "simple-code": "simple",
  "complex-code": "complex",
};

/** The model families the Claude tier table spans. The "tier" the savings lever
 * cares about is the model class, so routing compares families, not exact ids:
 * a `simple-code` dispatch already on a sonnet alias is correctly tiered. */
export type ModelFamily = "haiku" | "sonnet" | "opus";

/** Extract the Claude model family from a model id or alias, or `undefined`
 * when the string names no known family (e.g. a Codex `gpt-*` id). */
export function modelFamily(model: string | undefined): ModelFamily | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("opus")) return "opus";
  return undefined;
}

/** The PreToolUse payload slice this module reads. Tolerant of extra fields. */
export interface PreToolUseInput {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/**
 * The host-agnostic routing decision. `commands/route-model-tier.ts` serializes
 * it into the host's PreToolUse response shape.
 *
 *  - `noop`    — the dispatch is not a tier-agent, or is already correctly
 *                tiered: emit no change.
 *  - `rewrite` — path (a): correct the dispatch model in place via the host's
 *                input-rewrite capability (`updatedInput` on Claude).
 *  - `block`   — path (b): the host can decide but not rewrite; deny so the
 *                orchestrator retries on the right tier-agent.
 *  - `audit`   — path (c): the host can neither rewrite nor block; surface a
 *                nudge and allow.
 */
export type RouteAction =
  | { kind: "noop"; advice?: ModelTierPolicyAdvice }
  | {
      kind: "rewrite";
      tier: AfkModelTier;
      model: string;
      effort: AgentEffort;
      updatedInput: Record<string, unknown>;
      reason: string;
      advice?: ModelTierPolicyAdvice;
    }
  | { kind: "block"; tier: AfkModelTier; model: string; reason: string; advice?: ModelTierPolicyAdvice }
  | { kind: "audit"; tier: AfkModelTier; model: string; reason: string; advice?: ModelTierPolicyAdvice };

/** Which leg of the enforcement ladder the host can honour. */
export type EnforcementCapability = "rewrite" | "block" | "audit";

export interface ModelTierPolicyAdvice {
  source: string;
  taskClass: string;
  recommendedTier: AfkModelTier;
  confidence: number;
  posterior: readonly unknown[];
  explanation: string;
}

export interface RouteModelTierOptions {
  advice?: ModelTierPolicyAdvice;
  adoptAdvice?: boolean;
}

const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

function readSubagentType(input: PreToolUseInput): string | undefined {
  const v = input.tool_input?.["subagent_type"];
  return typeof v === "string" ? v : undefined;
}

function readModel(input: PreToolUseInput): string | undefined {
  const v = input.tool_input?.["model"];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Decide how to route a subagent dispatch against the config tier table.
 *
 * Returns `noop` unless the dispatch targets a tier-agent whose model family
 * disagrees with the family its config tier resolves to. When it disagrees,
 * the action follows the host's `capability`:
 *   - `rewrite` → carries the full `updatedInput` with `model` corrected to the
 *     config-resolved id (the rest of the original input preserved verbatim);
 *   - `block`   → deny-and-retry, leaving the model uncorrected;
 *   - `audit`   → allow with a nudge.
 *
 * The comparison is family-based: a dispatch already on the right model class
 * (even via a bare alias like `opus`) is a `noop`, so the hook never churns a
 * correctly-tiered call. An absent model on a tier-agent is treated as needing
 * correction — the config tier is authoritative over the agent frontmatter
 * default, so the resolved id is injected.
 */
export function routeModelTier(
  input: PreToolUseInput,
  config: ConfigValues,
  capability: EnforcementCapability = "rewrite",
  options: RouteModelTierOptions = {},
): RouteAction {
  if (!input.tool_name || !SUBAGENT_TOOLS.has(input.tool_name)) return { kind: "noop" };

  const subagentType = readSubagentType(input);
  if (!subagentType) return { kind: "noop" };

  const declaredTier = TIER_AGENT_TIERS[subagentType];
  if (!declaredTier) return adviceNoop(options.advice);

  const tier = options.adoptAdvice && options.advice ? options.advice.recommendedTier : declaredTier;
  const resolved = resolveTier(config, "claude", tier);
  const expectedFamily = modelFamily(resolved.model);
  const dispatched = readModel(input);
  const dispatchedFamily = modelFamily(dispatched);

  // Already correctly tiered: a model on the expected family. Nothing to do.
  if (dispatchedFamily !== undefined && dispatchedFamily === expectedFamily) {
    return adviceNoop(options.advice);
  }

  const reason =
    `model-tier-policy: ${subagentType} resolves to the '${tier}' tier ` +
    `(${resolved.model}, effort ${resolved.effort}) per .red/config.yaml ` +
    `plugins.dev.afk.models.claude.${tier} (ADR 0049); ` +
    (dispatched
      ? `dispatch requested '${dispatched}'`
      : `dispatch left the model unset`) +
    `.` +
    (options.adoptAdvice && options.advice
      ? ` Adopted brain advice: ${options.advice.explanation}`
      : options.advice
        ? ` Brain advice available but not adopted: ${options.advice.explanation}`
        : "");

  if (capability === "block") {
    return { kind: "block", tier, model: resolved.model, reason, ...(options.advice ? { advice: options.advice } : {}) };
  }
  if (capability === "audit") {
    return { kind: "audit", tier, model: resolved.model, reason, ...(options.advice ? { advice: options.advice } : {}) };
  }

  // path (a): rewrite. Preserve the full original input, override model and effort.
  const original = input.tool_input ?? {};
  const updatedInput: Record<string, unknown> = { ...original, model: resolved.model, effort: resolved.effort };
  return {
    kind: "rewrite",
    tier,
    model: resolved.model,
    effort: resolved.effort,
    updatedInput,
    reason,
    ...(options.advice ? { advice: options.advice } : {}),
  };
}

function adviceNoop(advice: ModelTierPolicyAdvice | undefined): RouteAction {
  return advice ? { kind: "noop", advice } : { kind: "noop" };
}
