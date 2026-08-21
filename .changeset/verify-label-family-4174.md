---
"@reddb-io/dev": patch
"@reddb-io/shared": patch
"@reddb-io/worker": patch
---

The `verify:<value>` label family makes the land precondition selective (ADR 0156 §2, #4174).

ADR 0154 applied ONE verification bar to every land, which prices a mechanical
one-liner at the same full review as a behavioural change. The bar is now
declared at triage: `verify:live`, `verify:tests` and `verify:gate-only` name the
minimum **Countersign** class a Ticket's land requires, declared once in
`@reddb-io/shared/verify-labels.js` and enforced by `decideLandCountersign`
through the new `insufficient-countersign` refusal reason — its own reason,
because "the verifier refused" and "the verifier passed too weakly" are different
repairs.

An unlabeled Ticket **fails closed** to ADR 0154's own bar, which is deliberately
not the weakest row in the table: only `verify:gate-only` admits the gate's own
`type-check-only` row under the implementer's identity, and only a triage human
may type it. A Ticket carrying two values resolves to the strictest, so a triage
disagreement cannot let the cheapest label decide. The bar reaches the gate from
the labels each entry point already holds — `LandingInput.labels` for the AFK
landing, `deps.ticket.labels` for the ACP Worker's land request — and an entry
point that holds none asks at the fail-closed default rather than assuming a
discount it cannot see.

A declared contract plus a ratchet
(`apps/plugin-dev/tests/verify-label-family-guard.test.ts`, registered as
`invariants:verify-label-family`) pins the family in both directions: the
declared strength ladder and the live passing set cover each other exactly, every
declared label lands at its minimum and refuses the class below it, and the
triage-labels doc teaches one row per label.
