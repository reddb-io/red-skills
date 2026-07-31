---
"@reddb-io/red-skills": patch
---

ADR 0130 Amendment 3 records that the daemon owns the demand loop: two players — the project's MCP registers, the daemon polls the tracker and drives — and the per-project `__supervise` process is removed rather than renamed.
