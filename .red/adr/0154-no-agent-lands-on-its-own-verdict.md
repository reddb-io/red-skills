# 0154 — No agent lands on its own verdict

- **Status**: accepted
- **Date**: 2026-08-20
- **Related**: ADR 0098 (state lanes and the validation sidecar exemption), ADR 0129 (adversarial review moved before the PR), ADR 0130 (the daemon owns process death; the Attempt is extinct), ADR 0136 (verdict as fault attribution), ADR 0148 (ACP publication wire)
- **Sources**: the pstack study of 2026-08-20 (Lauren Tan's `cursor/plugins/pstack`, verification-ledger and owner/verifier mechanisms); the maintainer's standing directive to maximize autonomy

## Context

Today the Worker that implements a Ticket also validates it and lands it. The
gate result is trusted transitively: `validation.jsonl` is a per-command,
per-workspace snapshot with no PR number, no commit SHA, and no aggregate
verdict; `LandingInput.validatedBranchTip` — built to pin "the commit landed is
the commit that passed validation" — is populated only by the reconcile path;
`merge.ts` pins `baseRefOid` for CI evidence but never compares `headRefOid`;
the ACP publish request names a commit and the land request drops it; and the
merge driver's PR record is keyed by PR number alone. Between gate-green and
merge, the branch ref is mutable and nothing notices.

An adversarial reviewer exists (`core/adversarial-review.ts`, a different
runner/model than the implementer, quorum aggregation) but it is default-off,
advisory, and an exception inside it degrades to `skipped` — which, by gate
semantics, never blocks. So even with review on, the Worker still lands on its
own verdict.

Removing the human spectator from the drain requires replacing the human's two
checks — "is this the diff that was validated?" and "does someone other than
the author think it's right?" — with structure.

## Decision

**Landing requires a verdict row written by an identity that did not implement
the change, pinned to the exact head being merged.**

1. **The verdict ledger.** A new TOONL lane, `.red/state/castle/verdicts.toonl`,
   owned by `core/verdict-ledger.ts`, with full four-way lane registration
   (retention registry, registry-referencing writer, writer-enforcement entry,
   census). Rows are append-only, keyed `(pr, head_sha, patch_id)`, and carry a
   `verifier_identity` (runner + model, or `human:<login>`). The verdict enum:
   `live-verified | test-verified | type-check-only | verifier-blocked |
   verifier-failed`. Supersession is an appended `voided` row, never a mutation.
   CI green is **evidence inside a row, never a verdict**: a row may cite a CI
   run; the run itself authorizes nothing. This lane is new and carries no ADR
   0098 sidecar exemption — it is TOONL, period.
2. **The verifier is the promoted adversarial reviewer.** `dev.review.enabled`
   defaults to true; the review stage's outcome is written to the ledger under
   the reviewer identity; and the stage **fails closed** — a reviewer exception
   or an unavailable reviewer runner produces a `verifier-blocked` row and parks
   the issue `ready-for-human`, never a silent `skipped`. An escape hatch
   `dev.review.mode: blocking | advisory` exists for operator recovery; the
   default is `blocking`. A separate verifier *process* (outside the Worker) is
   deferred; the identity split plus the ledger row carries the invariant.
3. **The land precondition.** Every land entry point refuses to merge unless
   the ledger holds a non-voided passing verdict whose `head_sha` equals the
   head actually being merged, with `stablePatchId()` as the fallback
   equivalence for clean rebases. A mismatch appends `voided` and routes to
   re-review. The entry points are enumerated, not discovered: the AFK
   lifecycle (`doLanding`), the merge driver (which records `armed_head_sha`
   and re-checks it every pass), the `land_branch` tool, the ACP land method
   (whose request now carries `commit`), and reconcile/`--adopt-branch` —
   where the human **is** the verifier and the landing records a
   `live-verified` row under `human:<login>` rather than being silently exempt.
4. **The SHA travels.** Publish already names a commit; land now does too
   (`RedskilledLandRequest.commit`, validated daemon-side), and the lifecycle
   populates `validatedBranchTip` on the ordinary AFK path.

## Considered options

- **A standalone verifier Worker per land.** Rejected for wave 1: the
  adversarial-review machinery already guarantees a distinct runner/model, and
  a second process buys isolation we do not yet need at the cost of a second
  admission path.
- **Extending `validation.jsonl` with SHA + verdict.** Rejected: it is a
  per-workspace gate artifact with a documented exemption and a rewrite-on-write
  contract; a merge authorization must be durable, append-only, and readable
  from outside the workspace that produced it.
- **Trusting CI status as the verdict.** Rejected explicitly: CI attests that
  commands passed on some head, not that an independent identity judged this
  head; and the head it ran on is precisely what today's pipeline fails to pin.

## Consequences

- A Worker's green gate stops being sufficient to merge; the drain's throughput
  cost is one review stage per land, already budgeted by the re-seed review
  sub-cap.
- `verifier-blocked` is a bounded, visible park — the queue can stall loudly,
  never deadlock silently. The breaker for a dead reviewer runner is the
  `advisory` mode switch, a human act.
- The ledger becomes the audit trail the morning human reads instead of diffs:
  who verified what, at which SHA, with what evidence.
