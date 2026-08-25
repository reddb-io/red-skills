---
"@reddb-io/github": patch
"@reddb-io/redskilled": patch
---

The GitHub ETag store is bounded by recency (256 entries, LRU) and the activity poll's time/content-derived cache keys are made stable. The uncapped store retained whole response bodies under keys that never repeated — a new key per trunk commit for compare payloads (patch text included) and a new key per hour per repository for the recently-closed pages — for the daemon's whole life; a host running only the daemon for ~4 days died of it. The ETag handshake is URL-scoped, so a reused key whose parameters moved gets a 200 and overwrites — never a wrong 304 body.
