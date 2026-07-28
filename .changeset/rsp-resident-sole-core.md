---
"@reddb-io/red-skills": patch
---

Every rsp surface is now a client of the resident core (#2688, ADR 0126). The pre-exec proxy, the CLI wrappers, `show`/`gains`, the bare dashboard, `stats`, `wait` capture and the MCP tool handlers previously each built their own store or opened a second connection to the same file; they all go through `residentElisionStore()` and the resident protocol instead, so the resident is the sole writer of the elision store and of the telemetry lanes it drains. Store construction is left in exactly two places — the store module (which owns the one-shot `rsp setup` provisioning open) and the resident server — and a contract test fails the build if a third appears. The fail-open guarantee is unchanged: an unreachable socket still yields the raw command's stdout, stderr and exit status, the dashboard and `stats` degrade to an empty snapshot, and `wait` keeps its spooled bytes rather than claiming a handle nothing can recover.
