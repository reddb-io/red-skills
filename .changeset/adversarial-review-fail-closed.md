---
"@reddb-io/dev": patch
---

Adversarial review becomes the **verifier** of ADR 0154: default on, fail-closed,
and every outcome written to the verdicts ledger. The review has existed since
ADR 0110 as an advisory pass that shipped off, and when on, its findings were
posted and the landing continued regardless — so a reviewer runner that was down,
a CLI that exited non-zero and an identity nobody could pin all produced exactly
the same observable as a clean review: nothing blocked, the branch landed, and
the morning read a green drain nobody had judged.

`dev.review.enabled` now ships `true` and a new `dev.review.mode` ships
`blocking`. A reviewer exception, an unwired reviewer runner, or an identity that
cannot be pinned distinct from the implementer is a `verifier-blocked` row plus a
`ready-for-human` park — visible and BOUNDED, because the stage asks the reviewer
exactly once, holds no retry and no wait, and its decision cannot say retry. A
reviewer that ran and refused is `verifier-failed` and stays with the
implementer, since a blocking finding is work the loop already routes.
`mode: advisory` is the operator escape hatch for draining while a reviewer
runner is repaired: nothing blocks and nothing parks, and every row is still
written, so an advisory drain stays auditable. An unrecognised mode resolves to
`blocking` — a typo must never silently disarm the verifier.

The identity is resolved rather than inherited. `resolveAdversarialReviewer`
defaults to the IMPLEMENTER when nothing is configured, which was defensible for
an advisory pass and is not once the outcome becomes an authorization: a
`test-verified` row signed by the model that wrote the diff is a self-verdict
wearing a ledger's clothes. `resolveReviewVerifier` refuses that — it walks a
preference order for a different `<runner>:<model>` and returns `null` when the
configuration offers none, which the stage turns into a park instead of a
signature. The reviewer itself is a declared seam: nothing here reaches a model,
a network or a clock, so the whole decision table is reproducible offline.
