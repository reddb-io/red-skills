---
"@reddb-io/red-skills": patch
---

Statusline per-worker proof-of-life (#2480): worker rows render a heartbeat age sourced from the same liveness evaluator `worker_vitals` uses, with quiet-but-live (`~`) visually distinct from wedged (stale lane AND no live descendants) — a live worker is never rendered as silent zeros without the age qualifier. Landing/rebase sub-agent executions (conflict resolvers, landing helpers) now stream their tool events into the parent worker's lane through the linked-subagent adapter, so the longest phases no longer read all-zero.
