---
"@reddb-io/red-skills": patch
---

Both arms of the balance wiring are judged, not just the one with an App

The composition of the daemon's balance registration lived as an inline ternary
inside `serve`, so the arm that matters most could not be tested: a host that
declares no GitHub App must produce exactly the registration it produced before
companions existed. That arm is now a named function with a test, and the test
distinguishes `undefined` from `[]` — an empty companion list would still send
the poller round a loop for a payer nobody declared.

Salvaged from a duplicate pull request that was closed as superseded; its one
non-redundant case was this seam.
