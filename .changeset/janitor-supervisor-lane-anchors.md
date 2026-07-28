---
"@reddb-io/red-skills": patch
---

The boot tmp-janitor no longer deletes the live supervisor lane (#2679). Its supervisor sweep keyed liveness off `afk-supervisor.pid` alone, so a supervisor still ticking without that file — its lane swept, or booted from a bundle predating the pid re-pin — was judged dead and had its runtime dir removed, after which `fleet_status` and `monitor` reported `pid 0, alive false` for a healthy fleet. A lane is now spared on ANY live anchor (pid file, the pid stamped into the fleet `state.toon` snapshot, or a live `s<pid>/` log dir), the supervisor stamps its pid into that snapshot on every heartbeat, and both the boot sweep and the runtime janitor refuse to delete a registered `.red/tmp` lane through the unknown-entry path.
