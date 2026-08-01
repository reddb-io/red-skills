---
"@reddb-io/red-skills": patch
---

A `/go` dispatch is now an ORDER, not the work. `/go` and `/go --scout` ran the reused AFK engine in the launching process, so a UI stop, a session teardown, or a closed terminal killed the dispatcher and took the run with it — two scout dispatches died exactly that way with no record anywhere. Both paths now ask the host daemon for the worker by default (the same birth port the MCP `worker_dispatch` uses, ADR 0130), so the process the work runs in is one the dispatcher is not the parent of, and the command returns as soon as the host grants it. The answer carries the two handles that outlive the launcher — the worker id and its log lane — so progress is observable without the process that started it. A host that grants no worker refuses the dispatch and starts nothing rather than falling back to an in-process run. `--attached` remains for a foreground debug session and states plainly that it dies with its caller.
