---
"@reddb-io/red-skills": patch
---

The `redskilled` daemon now measures each Worker tree's accumulated CPU time in the same per-tick walk that already produces its RSS (#2888). RSS cannot tell three states apart — a Worker running a long gate, a Worker hung on a wedged command, and a Worker already dead and unreaped all hold memory — and accumulated CPU time is what separates them. Answering "is this Worker alive and working?" used to mean walking `pstree` by hand, and in one session the state file gave the wrong answer twice, once in each direction.

**The second number costs no second instrument.** `utime + stime` is read from the `/proc/<pid>/stat` line the sampler already opened for `rss`, and on macOS from a `time=` column added to the one `ps` invocation that already reported RSS — so the tick's price stays a property of the host's process table rather than of how many Workers are running, which is the property that keeps the instrument cheap exactly when the machine is busy. The reading is `RedskilledTreeReading` (`rss` and `cpu_seconds` together, because they were taken together) and the daemon carries the sampled value on each Worker as `cpu`, dated by the tick that took it: two dated readings are what a comparison needs, and a Worker this tick could not measure keeps its last one rather than being erased or re-dated.

This delivers the measurement and nothing that acts on it. The reaper, the circuit breaker and the per-project stall policy are untouched, and the daemon still reports what a tree burned without judging the project's task (ADR 0130 rule 3).
