---
"@reddb-io/redskilled": patch
---

`go_dispatch` admits by RUNNING the turn, not by only birthing the process: the native Worker enters its Ticket loop only through a prompted handoff, so every dispatched Worker sat idle forever with its Ticket unclaimed. The admit now launches the same unattended demand turn the drain and the Mobile dispatch use (fire-and-forget, answer at admission, failure after the answer recorded as an acp-failure event), and the orphan go-admission path is deleted.
