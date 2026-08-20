# 0156 — Countersign is the word, and verification is selective

- **Status**: accepted
- **Date**: 2026-08-20
- **Related**: amends ADR 0154 (no agent lands on its own verdict); ADR 0136 (the Verdict is the gate's failure classifier); ADR 0110/0129 (adversarial review)
- **Sources**: the `/start` grilling session of 2026-08-20 over the same pstack study ADR 0154 imports (cached `.red/wiki/raw/pstack-*`); maintainer rounds Q19–Q24

## Context

ADR 0154 landed the verification ledger and the land precondition from the
pstack study — independently, on the same day this session reached the same
mechanism. Two frictions survive it. First, 0154 names its rows "verdicts"
while ADR 0136 already owns **Verdict** as the gate's pure classifier of a
failed Validation round: two meanings for one word in one pipeline, which is
how the next reader learns the wrong architecture. Second, 0154 applies the
promoted review stage uniformly to every land; it never considered — and so
never rejected — declaring, per Ticket, how much verification the change
actually needs, which prices every mechanical one-liner at a full review.

This session had also chosen a standalone daemon-spawned Verify Worker;
confronted with 0154's wave-1 argument (the adversarial-review machinery
already guarantees a distinct runner/model identity, and a second admission
path is real cost), the maintainer accepted the deferral.

## Decision

1. **Countersign is the word.** The gate signs its own work; the Countersign
   is the second signature, from an identity that did not implement the
   change. 0154's rows, ledger, and lane are renamed before implementation:
   the lane is `.red/state/castle/countersigns.toonl` (same four-way lane
   registration, same append-only/`voided` semantics, same
   `(pr, head_sha, patch_id)` key and `verifier_identity`). The class enum is
   unchanged from 0154: `live-verified | test-verified | type-check-only |
   verifier-blocked | verifier-failed`. Every other 0154 mechanism stands as
   landed.
2. **Verification is selective, declared at triage.** The `verify:<value>`
   label family (`verify:live`, `verify:tests`, `verify:gate-only`) names the
   minimum Countersign class a Ticket's land requires. An unlabeled Ticket
   fails closed — full review, as 0154 defaults. `verify:gate-only` is an
   explicit, human-declared exemption to 0154's invariant: the Ticket lands
   on the gate's own SHA-pinned row, under the implementer's identity,
   because a triage human judged the change mechanical — the authorization
   is the label, never the author's own opinion of the change. Neither a
   daemon heuristic nor author self-declaration may pick the class.
3. **The Verify Worker is wave 2.** The promoted adversarial reviewer
   (default-on, fail-closed, distinct runner/model — 0154 §2) carries the
   invariant now. The standalone daemon-spawned Verify Worker on a different
   model family remains the escalation when process isolation justifies a
   second admission path.

## Considered options

- Keep "verdict" and live with the overload. Rejected: 0136's Verdict is
  implemented and load-bearing; 0154 is design-pending, so the rename costs
  a text edit today and a migration later.
- Uniform review on every land (0154 as landed). Rejected as the only mode:
  it prices mechanical changes at a full review; the label keeps the default
  (fail closed) while letting triage buy the discount explicitly.
- Standalone Verify Worker in wave 1 (this session's first choice).
  Rejected on 0154's argument, adopted here as the named wave-2 path.
