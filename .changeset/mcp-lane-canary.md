---
"@reddb-io/red-skills": patch
---

The MCP lane now carries a canary (#2706, ADR 0128 §7). `castle-mcp __mcp-canary` walks the shipped lane end to end over the real MCP stdio transport — `fleet_create` → a slot that spawns a real worker → `fleet_status` → `fleet_stop` — and exits non-zero naming the step that went inert. A returned supervisor pid is explicitly not accepted as drainage: only a worker directory holding a live `worker.pid` is, which is exactly what #2677's dead slots never wrote. CI runs the same walk on every PR against two bundles that differ solely in whether the slot entry can route `run`, so a lane that silently drains nothing fails the gate instead of surviving unnoticed.
