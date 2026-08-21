---
"@reddb-io/redskilled": patch
"@reddb-io/dev": patch
---

A declared drain budget stops admission at the harvest fraction and lands what is in flight.

A drain that admits a Worker ten minutes before its budget dies buys a claim it cannot land, and finished-but-unlanded work counts as zero (#4170, Spec #4164). A drain registration may now state `budget_ms` — with an optional `harvest_fraction`, 0.7 by default — and past that fraction of the budget `planHostDemand` reports `harvest-deadline` and admits no new claim, while every Worker already alive keeps publishing and landing what it carries: the deadline gates births and never the landing lane. The policy lives in one pure module (`apps/redskilled/src/harvest-deadline.ts`) with the daemon shape-checking the two numbers and reading no meaning, and `project_status` — the drain summary an operator reads — gains a `harvest` block naming the deadline instants beside `harvested` against `stranded`, the second folded from the same terminal outcome class the birth breaker reads plus the work the deadline leaves behind. **No declared budget, no deadline**: the policy reports `inert`, refuses nothing, and the daemon invents no instant the operator did not ask for.
