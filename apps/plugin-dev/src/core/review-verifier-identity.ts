// review-verifier-identity — who is allowed to countersign the row that lets a
// branch land (ADR 0154/0156, Spec #4129, Tickets #4137 and #4172).
//
// ADR 0154's rule is one sentence: **no agent lands on its own Countersign.** The
// review stage already resolves a reviewer through `resolveAdversarialReviewer`,
// and that resolver is deliberately permissive — with nothing configured it
// returns the IMPLEMENTER's own runner and model, because as an advisory pass
// "review yourself once more" was better than not reviewing at all.
//
// It is not better than not reviewing at all once the outcome becomes an
// authorization. A `test-verified` row signed `claude:claude-opus-5` for a diff
// that `claude:claude-opus-5` wrote is a self-signature wearing a ledger's
// clothes: every land precondition downstream reads it as a second opinion, and
// there was none. So the identity is resolved HERE, with the distinctness as the
// rule rather than as a hope, and a resolution that cannot find a different
// identity returns `null` — which the fail-closed stage turns into
// `verifier-blocked` and a visible park, never into a silent self-signature.
//
// The bar is the one ADR 0154 states: a different `<runner>:<model>` pair. It is
// deliberately coarser than the Attention audit's model-FAMILY bar (#4171),
// because that audit re-reads reasoning — where a same-family judge re-accepts
// its own blind spots — while this one re-reads a DIFF, which is an artifact any
// second identity can read cold.

import {
  resolveAdversarialReviewer,
  type AdversarialReviewConfig,
} from "./adversarial-review.js";
import type { AfkModelTier } from "./config.js";
import type { AgentEffort, AgentRunner } from "./execution.js";
import { agentVerifierIdentity } from "./countersign-ledger.js";

/** The identity that produced the diff — the one a verifier must NOT be. */
export interface ReviewImplementerIdentity {
  readonly runner: AgentRunner;
  readonly model: string;
  readonly effort?: AgentEffort;
}

/** A resolved verifier: the reviewer tuple plus the ledger identity it signs with. */
export interface ReviewVerifier {
  readonly runner: AgentRunner;
  readonly model: string;
  readonly effort?: AgentEffort;
  /** `<runner>:<model>`, exactly as the Countersign row's `verifier_identity`. */
  readonly identity: string;
  /** Substitution notices from the reviewer resolver, for the caller to log. */
  readonly notices: readonly string[];
}

/**
 * Order in which alternative runners are tried once the configured reviewer
 * turns out to be the implementer itself. Order decides only WHICH different
 * identity is chosen; distinctness is enforced below, so this list can never
 * smuggle a self-signature in.
 */
export const REVIEW_VERIFIER_RUNNER_PREFERENCE: readonly AgentRunner[] = [
  "codex",
  "claude",
  "opencode",
  "claude-minimax",
];

export interface ReviewVerifierInput {
  readonly config: AdversarialReviewConfig;
  readonly implementer: ReviewImplementerIdentity;
  readonly taskClass?: AfkModelTier;
  readonly resolveTier?: (
    runner: AgentRunner,
    taskClass?: AfkModelTier,
  ) => { readonly model: string; readonly effort?: AgentEffort };
  /** Override the fallback order. Exposed so the no-alternative branch is testable. */
  readonly preference?: readonly AgentRunner[];
}

/** `<runner>:<model>` for the identity that wrote the diff. PURE. */
export function reviewImplementerIdentity(implementer: ReviewImplementerIdentity): string {
  return agentVerifierIdentity(implementer.runner, implementer.model);
}

function verifierFor(input: ReviewVerifierInput, runner?: AgentRunner): ReviewVerifier {
  const config: AdversarialReviewConfig =
    runner === undefined ? input.config : { ...input.config, runner };
  const resolved = resolveAdversarialReviewer({
    config,
    implementer: input.implementer,
    ...(input.taskClass === undefined ? {} : { taskClass: input.taskClass }),
    ...(input.resolveTier === undefined ? {} : { resolveTier: input.resolveTier }),
  });
  return {
    runner: resolved.runner,
    model: resolved.model,
    ...(resolved.effort === undefined ? {} : { effort: resolved.effort }),
    identity: agentVerifierIdentity(resolved.runner, resolved.model),
    notices: resolved.notices ?? [],
  };
}

/**
 * The identity that may countersign this diff, or `null` when none differs
 * from the implementer's.
 *
 * The configured reviewer is honoured whenever it is already a different
 * identity. When it is not — the ordinary unconfigured case, where the resolver
 * hands back the implementer — the preference order is walked and the first
 * runner producing a different `<runner>:<model>` wins. `null` means the
 * configuration offers no second identity at all, and that is a REFUSAL for the
 * caller to park on, never a licence to sign twice. PURE.
 */
export function resolveReviewVerifier(input: ReviewVerifierInput): ReviewVerifier | null {
  const own = reviewImplementerIdentity(input.implementer);
  const configured = verifierFor(input);
  if (configured.identity !== own) return configured;
  for (const runner of input.preference ?? REVIEW_VERIFIER_RUNNER_PREFERENCE) {
    if (runner === input.implementer.runner) continue;
    const alternative = verifierFor(input, runner);
    if (alternative.identity !== own) return alternative;
  }
  return null;
}

/**
 * The configuration assertion as a sentence rather than a throw: `null` when a
 * distinct verifier exists, otherwise the line a human needs to fix the config.
 * PURE.
 */
export function reviewVerifierRefusal(input: ReviewVerifierInput): string | null {
  if (resolveReviewVerifier(input) !== null) return null;
  const own = reviewImplementerIdentity(input.implementer);
  const offered = (input.preference ?? REVIEW_VERIFIER_RUNNER_PREFERENCE).join(", ") || "(none)";
  return `no configured runner (${offered}) resolves to an identity other than the implementer's ${own}; the review would sign the diff it wrote`;
}
