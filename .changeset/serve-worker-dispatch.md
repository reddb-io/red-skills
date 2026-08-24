---
"@reddb-io/dev": patch
"@reddb-io/redskilled": patch
---

worker_dispatch now serves demand-form dispatches through the daemon's `_redskills/go_dispatch` — the first slice-2 landing on the rs_dev routing table (#4113): the daemon mints the disposable lane:go Ticket, admits the Worker, and answers with its id; issue-form dispatches, mode, and runner refuse by name because the wire deliberately carries the demand alone.
