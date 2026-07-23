---
"@reddb-io/red-skills": patch
---

Unified local issue-lease (#2578): the two local-lease twins over `.red/tmp/claims/` — `tryAcquireClaimDir` and `createFsIssueLeaseStore` — converge on the proven mkdir-lock semantics, one engine for every claim path. (The CLI help guard half of this branch was superseded by the #2581 fix already on main.)
