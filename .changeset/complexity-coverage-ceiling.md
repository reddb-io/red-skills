---
"@reddb-io/dev": patch
---

A CRAP-style ceiling on untested complexity joins the repo-wide invariants. A
green suite was never evidence that the hard code ran: a forty-branch function
no test ever names passes the tests, the types and the lint, and lands. The new
ratchet scores every exported function under `apps/` and `packages/` as
`complexity + complexity²` when no test in its owning package references the
name, holds it to a ceiling of 240, and records the 61 functions that predate
it in a shrink-only baseline. The coverage signal is a deterministic static
proxy rather than a coverage run, because the suite executes inside every
cone-scoped gate; swapping in real per-function coverage later tightens the
same rule without changing it.
