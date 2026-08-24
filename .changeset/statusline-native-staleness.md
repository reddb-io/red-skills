---
"@reddb-io/redskilled": patch
---

The native statusline front dates its cached render: a cache older than 15 minutes prints with a `!stale <N>m` mark instead of a frozen line wearing a live face — a background renderer that stops rewriting the cache is now visible at the prompt.
