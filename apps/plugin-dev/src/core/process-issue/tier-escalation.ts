// tier-escalation — a repeated failure signature buys a HIGHER tier rather than
// another round at the tier that just failed (ADR 0129 decision 6, issue #2729).
//
// Repeating the same tier against the same failure is the lowest-yield round
// available: nothing about the round changed, so nothing about its outcome is
// expected to. The tier is the one variable that moves the chance of
// converging, so the repeat is what buys it — and it buys it from the `tier`
// sub-cap, never the gate's, which is what keeps gate correction whole while the
// escalation happens (ADR 0129, defect 1).
//
// The trigger is a REPEAT, not a failure. The previous round's failure signature
// (#2724) equal to this round's means the round failed the same way; anything
// else — a different failure set, or a set that merely shrank — is progress, and
// progress is re-instructed at the tier that produced it.
//
// Pure and total: the caller owns the signatures, the budget, and the tally.

import { AFK_MODEL_TIERS, type AfkModelTier } from "../config.js";
import { EMPTY_FAILURE_SIGNATURE } from "../failure-signature.js";
import { reseedDraw, type ReseedBudget, type ReseedSpend } from "./reseed-budget.js";

/** The escalation ladder, `validate → simple → complex → think`. It IS the
 * model-tier vocabulary in its declared order — a second ordering would be a
 * second truth about which tier is dearer. */
export const RESEED_TIER_LADDER: readonly AfkModelTier[] = AFK_MODEL_TIERS;

/** The dearest tier on the ladder. A repeat here has nothing left to buy. */
export const RESEED_TOP_TIER: AfkModelTier = RESEED_TIER_LADDER[RESEED_TIER_LADDER.length - 1]!;

/** One step up the ladder, or `undefined` at the top. Mirror of
 * `downgradeAfkModelTier`, and deliberately NOT saturating: the top tier
 * returning itself would read as a granted escalation that changed nothing. */
export function escalateAfkModelTier(tier: AfkModelTier): AfkModelTier | undefined {
  const idx = RESEED_TIER_LADDER.indexOf(tier);
  if (idx < 0 || idx >= RESEED_TIER_LADDER.length - 1) return undefined;
  return RESEED_TIER_LADDER[idx + 1]!;
}

/** Why an escalation was refused. `no-repeat` — the failure moved, so the tier
 * stays put; `ladder-top` — the repeat is already on the dearest tier, so the
 * ladder terminates and the caller parks; the remaining three are
 * {@link reseedDraw}'s own refusals, passed through unchanged so a reader can
 * tell a budget refusal from a policy one. */
export type TierEscalationRefusal = "no-repeat" | "ladder-top" | "sub-cap" | "ceiling" | "reservation";

export type TierEscalationDecision =
  | { readonly escalate: true; readonly from: AfkModelTier; readonly to: AfkModelTier }
  | { readonly escalate: false; readonly refusal: TierEscalationRefusal };

export interface TierEscalationInput {
  /** The tier the round that just failed ran on. */
  readonly tier: AfkModelTier;
  /** The signature of the PREVIOUS round, or {@link EMPTY_FAILURE_SIGNATURE}
   * when this is the first round to fail. */
  readonly previousSignature: string;
  /** The signature of the round that just failed. */
  readonly signature: string;
  readonly budget: ReseedBudget;
  readonly spend?: ReseedSpend;
}

/**
 * Decide whether this round's failure escalates the tier.
 *
 * The three refusals are checked in the order a reader would ask them: did the
 * failure actually repeat, is there a dearer tier to buy, and can the `tier`
 * sub-cap pay for it. A round with nothing identifiable failing is never a
 * repeat — an empty signature equal to an empty signature says the two rounds
 * were both unreadable, not that they failed the same way.
 */
export function decideTierEscalation(input: TierEscalationInput): TierEscalationDecision {
  const signature = input.signature || EMPTY_FAILURE_SIGNATURE;
  const repeated = signature !== EMPTY_FAILURE_SIGNATURE && signature === input.previousSignature;
  if (!repeated) return { escalate: false, refusal: "no-repeat" };

  const to = escalateAfkModelTier(input.tier);
  if (!to) return { escalate: false, refusal: "ladder-top" };

  const draw = reseedDraw(input.budget, "tier", input.spend ?? {});
  if (!draw.allowed) return { escalate: false, refusal: draw.refusal ?? "sub-cap" };

  return { escalate: true, from: input.tier, to };
}
