---
"@reddb-io/dev": patch
"@reddb-io/shared": patch
---

The verdict ledger of ADR 0154 gets its own TOONL lane. A merge authorization
cannot live in `validation.jsonl` — that sidecar is rewritten on every write,
names no PR and no SHA, and dies with the workspace — so `verdicts` is a new
append-only lane in the durable Castle state tier, owned by
`core/verdict-ledger.ts`. Rows are keyed `(pr, head_sha, patch_id)`, carry a
`verifier_identity` (`<runner>:<model>`, or `human:<login>`) and one of the five
closed verdicts, and cite CI as evidence rather than as authorization.
Superseding a standing verdict appends a `voided` row; nothing is ever edited or
removed, because a ledger a writer can rewrite is a ledger an auditor cannot
trust. The lane lands with all four registrations a new TOONL lane owes — the
retention registry entry, a writer that reads that entry at append time, the
writer-enforcement declaration, and the census — plus its place among the
declared durable members of `.red/state/castle`. No consumer is wired yet.
