---
"@reddb-io/redskilled": patch
---

A Worker row's published heartbeat string is dated once its publication goes stale — `hb=3s (published 9m0s ago)` — so a wedged Worker no longer renders identically to a working one; a fresh publication stays untouched.
