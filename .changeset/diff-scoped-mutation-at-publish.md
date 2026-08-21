---
"@reddb-io/dev": patch
---

Diff-scoped mutation testing now runs once per publish, inside the review stage,
under a hard wall-clock budget. Single-token operator swaps — boundary,
negation, arithmetic, logical, boolean literal — are planned by an AST walk over
only the lines the diff touched, and a complete run below the configured
threshold refuses the publish under `verifier-failed`, naming every mutant the
tests let through. Crossing the budget cancels the in-flight run and degrades to
an advisory note in the verdict row with a clean exit: a truncated score is not
the score of the change, so it never blocks and is never presented as a full run.
The poll that waits on one mutant is declared with its subject, deadline and
escalation.
