// brief-contract-promotion — the first door: an issue whose brief is not
// executable never becomes `ready-for-agent` (Spec #4129, Ticket #4139).
//
// `planTriageTransition` is a decision APPLICATOR: whatever the four triage
// outcomes are, it emits the label delta that records one. That is right for
// three of them and wrong for the fourth, because `ready-for-agent` is not a
// record of a human's opinion — it is a PROMISE to the drain that a Worker can
// finish this issue from its body alone. A brief that says "make the retry
// logic better" cannot be finished from its body, and promoting it spends a
// whole Worker workspace to discover that.
//
// So promotion, and only promotion, is gated here. The other three decisions
// pass through untouched: refusing to record "wontfix" because the acceptance
// criteria are vague would be an absurdity, and `needs-info` is the state a
// vague issue is SUPPOSED to be able to reach.
//
// ## A refusal keeps the issue where it already was
//
// The refused plan routes back to `needs-triage` rather than inventing a new
// parking state, because that is where the triage skill has always said a
// vague brief belongs, and because a refusal that leaves the issue label-less
// is a refusal no queue census can see. Paired with it is the recipe comment
// triage already knows how to render — planned, never posted, from here: this
// module is pure, and the caller owns every write.
//
// ## Specs are exempt, deliberately
//
// A `type:spec` issue is a design record whose Tickets carry the executable
// criteria; linting the Spec would demand machine-checkable items of the one
// document whose job is to decide what they should be. The read-only doctor
// has exempted Specs since it shipped, and a gate that judged them differently
// from the doctor reporting on it would be two rules wearing one name.

import { LABEL_NEEDS_TRIAGE, LABEL_READY, LABEL_TYPE_SPEC } from "./triage-labels.js";
import { planTriageTransition, type TriageDecision, type TriageTransition } from "./auto-triage.js";
import {
  planAcceptanceCriteriaRecipeCommentUpdate,
  type AcceptanceCriteriaRecipeComment,
  type AcceptanceCriteriaRecipeCommentUpdate,
} from "./executable-acceptance.js";
import { briefContractRefusal, lintExecutableAcceptanceCriteria } from "@reddb-io/shared/brief-contract.js";

/** Labels whose issues the brief contract does not judge. */
export const BRIEF_CONTRACT_EXEMPT_LABELS: readonly string[] = [LABEL_TYPE_SPEC];

/** What the gate did: let the decision through, or refuse the promotion. */
export type BriefGatedPromotionOutcome = "applied" | "refused";

export interface BriefGatedPromotionInput {
  /** The triage decision a maintainer or the router reached. */
  readonly decision: TriageDecision;
  /** The issue body the lint judges. */
  readonly body: string;
  /** The issue's current labels, for the ADR 0122 full delta and the exemption. */
  readonly labels?: readonly string[];
  /** Comments already on the issue, so the recipe comment stays idempotent. */
  readonly comments?: readonly AcceptanceCriteriaRecipeComment[];
}

export interface BriefGatedPromotion {
  readonly outcome: BriefGatedPromotionOutcome;
  /** The label delta to apply — the decision's own, or the route back. */
  readonly transition: TriageTransition;
  /** The lint's finding, verbatim, or `null` when nothing was refused. */
  readonly refusal: string | null;
  /** The checklist items the lint read, so a caller can quote them too. */
  readonly items: readonly string[];
  /** The recipe comment to post, planned but never written. `null` on success. */
  readonly recipeComment: AcceptanceCriteriaRecipeCommentUpdate | null;
}

/**
 * Plan a triage transition with the brief contract in front of it. PURE.
 *
 * Only a `ready-for-agent` decision is judged, and only for an issue no exempt
 * label covers. Everything else is `planTriageTransition`'s answer, unchanged.
 */
export function planBriefGatedTriageTransition(
  input: BriefGatedPromotionInput,
): BriefGatedPromotion {
  const labels = input.labels ?? [LABEL_NEEDS_TRIAGE];
  const applied = (): BriefGatedPromotion => ({
    outcome: "applied",
    transition: planTriageTransition(input.decision, labels),
    refusal: null,
    items: [],
    recipeComment: null,
  });

  if (input.decision !== "ready-for-agent") return applied();
  if (labels.some((label) => BRIEF_CONTRACT_EXEMPT_LABELS.includes(label))) return applied();

  const refusal = briefContractRefusal(input.body);
  if (refusal == null) return applied();

  const lint = lintExecutableAcceptanceCriteria(input.body);
  return {
    outcome: "refused",
    transition: { remove: [LABEL_READY], add: [LABEL_NEEDS_TRIAGE], close: false },
    refusal,
    items: lint.items,
    recipeComment: planAcceptanceCriteriaRecipeCommentUpdate(input.comments ?? [], lint),
  };
}
