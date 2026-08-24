---
"@reddb-io/redskilled": patch
---

A daemon boot resumes every active merge-custody obligation from the durable snapshot and keeps re-tendering on a slow interval — a restart no longer strands handed-off PRs on `repair-custodian` until a client happens to ask.
