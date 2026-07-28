---
"@reddb-io/red-skills": patch
---

MCP-launched fleets drain again (#2677): the supervisor no longer infers the slot's worker entry from `process.argv[1]`. Under the ADR 0120 MCP lane the supervisor is itself the castle-mcp bundle, whose entry does not route `run`, so every slot booted a second resident/stdio host, lost the singleton lease and died — `deaths == respawns`, `slots_busy=0`, zero drainage. `spawnSlot`/`spawnReconcileWorker` now resolve the sibling dev bundle (the entry that routes `run`), and the castle-mcp entry refuses an unroutable subcommand by name instead of silently falling through to the resident path.
