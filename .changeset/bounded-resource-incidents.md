---
"@reddb-io/red-skills": patch
---

The daemon captures bounded resource incidents

A Worker terminated for memory left the host knowing only that it was over its
budget. The daemon now reads the kernel's full cgroup v2 forensic surface —
memory current/peak/swap and its event counters, CPU usage and throttling, the
PSI pressure files, pid counts — and keeps a bounded record of the incidents it
acted on.

The reader is deliberately TOTAL: a counter the kernel did not expose comes back
as a stated zero, so an incident record has no missing fields to interpret. That
property is exactly wrong one layer up, where a zero and an absence mean
different things — the daemon stamps a fresh `sampled_at` on every CPU reading it
is handed, so recording an absent `cpu.stat` as zero would date a measurement
nobody took and lose the last one the Worker really had. The sampler therefore
reports CPU only for a unit whose `cpu.stat` the kernel actually exposes.
