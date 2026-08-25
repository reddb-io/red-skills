---
"@reddb-io/redskilled": minor
---

The daemon protects the machine from itself: a self-guard in the binary probes the daemon's own op socket with a client's ping (two minutes of sustained misses = deliberate exit 70 — a wedged-but-alive process that `Restart=always` never fires for now self-heals) and watches its own RSS (past 1.5GiB = deliberate exit 71 — shedding a multi-day leak is one restart, losing the machine is an outage). The unit template additionally declares `MemoryHigh=1G` / `MemoryMax=2G` so even a guard-dead daemon cannot take the host down; host drop-ins still override.
