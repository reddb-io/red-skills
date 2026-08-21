// attention-audit-identity — who is allowed to judge a drain's Decision trail
// (Spec #4164, Ticket #4171).
//
// The Attention audit is worth reading only because the identity that writes it
// did not do the work. An agent grading its own night grades its own reasoning
// with that reasoning still loaded: the fork it thought obvious reads obvious
// again, and the evidence it accepted once it accepts twice. **The audit's whole
// value is the second opinion**, so the identity is a CONFIGURATION fact with an
// assertion on it, not a runner somebody happened to have spare.
//
// The rule is a property, never a hardcoded name: the audit runs on the first
// supported runner whose CONFIGURED model sits on a different model family than
// the drain's Workers. Point the drain at codex and the audit moves to claude on
// its own. Point every runner in the config at one family and the audit refuses
// to pin an identity at all — a same-family "cross-model" audit is the failure
// this module exists to name, and naming it beats performing it.

import { resolveTaskRoute, resolveTier, type AfkModelTier, type ConfigValues } from "./config.js";
import { runners, type Runner } from "../types/runner.js";

/**
 * A model family COARSE enough to answer the only question the audit asks: is
 * this a different mind than the one that did the work? `ModelFamily` in
 * `model-tier-route.ts` splits Claude into haiku/sonnet/opus, which is the right
 * grain for cost tiering and the wrong grain here — two Claude tiers share
 * training, refusal shape and blind spots.
 */
export type JudgeModelFamily = "anthropic" | "openai" | "google" | "minimax" | "unknown";

/** The tier the judgment runs at: reading a trail against outcomes is a
 * validation task, not an implementation one (the model-tier-policy skill). */
export const ATTENTION_AUDIT_TIER: AfkModelTier = "validate";

/** The tier the drain's Workers run their code work at, and so the identity the
 * audit must differ FROM. */
export const DRAIN_WORKER_TIER: AfkModelTier = "complex";

/**
 * Preference order for the auditing runner. Order decides only WHICH qualifying
 * runner is chosen; qualification itself is the family difference below, so this
 * list can never smuggle a same-family judge in.
 */
export const ATTENTION_AUDIT_RUNNER_PREFERENCE: readonly Runner[] = [
  "codex",
  "claude",
  "opencode",
  "claude-minimax",
];

/** The identity that ran, or would run, one side of the comparison. */
export interface AttentionAuditIdentity {
  readonly runner: Runner;
  readonly model: string;
  readonly family: JudgeModelFamily;
}

const FAMILY_MARKERS: readonly (readonly [string, JudgeModelFamily])[] = [
  ["anthropic", "anthropic"],
  ["claude", "anthropic"],
  ["minimax", "minimax"],
  ["gemini", "google"],
  ["google", "google"],
  ["gpt", "openai"],
  ["openai", "openai"],
  ["codex", "openai"],
];

/**
 * The family a configured model id belongs to. **`unknown` is never equal to
 * anything, including itself** — an id we cannot place is not evidence of a
 * second opinion, so the caller treats it as unusable rather than as different.
 * PURE.
 */
export function judgeModelFamily(model: string): JudgeModelFamily {
  const id = model.toLowerCase();
  for (const [marker, family] of FAMILY_MARKERS) {
    if (id.includes(marker)) return family;
  }
  return "unknown";
}

/**
 * The identity the drain's Workers carry: whatever runner the config routes code
 * work to, at the model that runner's table resolves for the complex tier. PURE
 * over the values handed in — it reads no env and no filesystem.
 */
export function resolveDrainWorkerIdentity(values: ConfigValues): AttentionAuditIdentity {
  const route = resolveTaskRoute(values, DRAIN_WORKER_TIER);
  return { runner: route.runner, model: route.model, family: judgeModelFamily(route.model) };
}

function identityFor(values: ConfigValues, runner: Runner): AttentionAuditIdentity | null {
  try {
    const tier = resolveTier(values, runner, ATTENTION_AUDIT_TIER);
    return { runner, model: tier.model, family: judgeModelFamily(tier.model) };
  } catch {
    // A runner with no model table cannot be an identity. Borrowing another
    // runner's table to fill the gap is exactly the silent inheritance the
    // config refuses.
    return null;
  }
}

/**
 * The auditing identity: the first preferred runner on a KNOWN family that
 * differs from the drain's. Returns `null` when the configuration offers no such
 * runner — the audit then still assembles, and says out loud that it is unpinned.
 * PURE.
 */
export function resolveAttentionAuditIdentity(
  values: ConfigValues,
): AttentionAuditIdentity | null {
  const drain = resolveDrainWorkerIdentity(values);
  if (drain.family === "unknown") return null;
  for (const runner of ATTENTION_AUDIT_RUNNER_PREFERENCE) {
    const candidate = identityFor(values, runner);
    if (candidate === null || candidate.family === "unknown") continue;
    if (candidate.family !== drain.family) return candidate;
  }
  return null;
}

/**
 * The configuration assertion, as a reason string rather than a throw: `null`
 * when the audit identity is pinned to a different family than the drain's
 * Workers, otherwise the sentence a human needs to fix the config. A ratchet
 * test asserts this is `null` for the shipped defaults. PURE.
 */
export function attentionAuditIdentityRefusal(values: ConfigValues): string | null {
  const drain = resolveDrainWorkerIdentity(values);
  if (drain.family === "unknown") {
    return `drain Workers run ${drain.runner}/${drain.model}, whose model family is unrecognised — no identity can be proven different from it`;
  }
  const audit = resolveAttentionAuditIdentity(values);
  if (audit === null) {
    const spelled = runners.join(", ");
    return `no configured runner (${spelled}) offers a model on a family other than ${drain.family}; the Attention audit would grade the drain with the drain's own mind`;
  }
  if (audit.family === drain.family) {
    return `audit identity ${audit.runner}/${audit.model} shares the drain's ${drain.family} family`;
  }
  return null;
}
