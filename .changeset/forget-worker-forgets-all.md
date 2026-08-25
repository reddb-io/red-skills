---
"@reddb-io/redskilled": patch
---

`forgetWorker` now forgets everything: the resource-incident tracker gains `forget(targetId)` (a Worker that died mid-incident — the OOM-kill shape — pinned its open incident's full sample buffer, up to 4096 samples, for the daemon's life, and a calm death froze ~10 minutes of ring samples), and the two per-Worker maps the eviction missed (`metricCheckpoints`, `workerHighWater`) plus the runtime's never-finalized `persistedAt` entries are dropped with it. Leak-audit findings #2 and #3.
