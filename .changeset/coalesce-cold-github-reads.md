---
"@reddb-io/github": patch
"@reddb-io/rsp": patch
---

Coalesce cold same-kind single-object reads into one aliased GraphQL query when their count exceeds a threshold derived from the live REST and GraphQL balances, while preserving conditional REST for warm reads.
