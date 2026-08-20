---
"@reddb-io/redskilled": patch
---

Each Worker's redcode child gets its own database: the daemon sets
`OPENCODE_DB` to a file in the Worker's disposable workspace, because
concurrent redcode instances sharing one opencode.db die on "database is
locked" mid-turn (redcode#58) — one agent's write aborted another's whole
turn on every multi-Worker machine.
