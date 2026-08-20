---
"@reddb-io/redskilled": patch
---

The mirror trunk refresh runs one-at-a-time per mirror and a stale fork's
journal line carries git's own words. Two Workers materializing together
raced two fetches on one FETCH_HEAD lock (the loser forked stale), and the
loud line said only "failed" — the diagnosis needed the reason.
