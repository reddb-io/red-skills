---
"@reddb-io/redskilled": patch
---

The Worker pulse carries the Ticket stage into the statusline: each
ticket-stage notification stamps `phase` (with `!` on a blocked stage) and
the round into the Worker's display, so the row reads
`iss=#4157 claim→implement→gate` instead of an id and an age — the
observability the demolition took from the statusline, restored from the
facts the daemon already receives.
