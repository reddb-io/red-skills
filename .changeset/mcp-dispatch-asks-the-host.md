---
"@reddb-io/red-skills": patch
---

`worker_dispatch` asks the daemon for its Workers instead of starting them itself. Every MCP dispatch — issue, demand and scout — held its own `spawn`, so three Workers ran on 3.1.1 while `host-state` reported `workers: 0`, nothing reached the host event lane and nothing was counted against the budget; unbudgeted Workers are unsampled Workers, and this is the memory pressure no OOM record survived. A dispatch now requests a birth over the same port the rest of the project uses and refuses with a named reason when no daemon answers, rather than falling back to a launch no admission verdict judged. `apps/dev/src/mcp-adapter.ts` is declared in the `host-owns-birth` inventory, so the ratchet watches the surface an operator actually reaches for — it read clean throughout, because a ratchet only watches the sites it is told about.
