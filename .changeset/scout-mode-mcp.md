---
"@reddb-io/red-skills": minor
---

Castle-MCP H8 (#2346): `worker_dispatch` gains `mode: "scout"` — read-only investigations reachable through the MCP. Scout is demand-only (rejected with an issue number at input validation), routes through the scout dispatch operation into the `.red/tmp/scout-workers/` lane, and never mutates the tracker.
