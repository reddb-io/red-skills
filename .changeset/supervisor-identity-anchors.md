---
"@reddb-io/red-skills": patch
---

`fleet_status` and `fleet_stop` can no longer go blind to a live supervisor (#2698). Every management read resolved the supervisor's identity from `afk-supervisor.pid` alone, so a ticking fleet whose lock was missing — or whose `.pid.start` sidecar was gone — reported `pid 0, alive false, health absent` in the same response that carried a 13-second-old heartbeat and two busy slots, while `fleet_stop` answered `status: none` and the operator had to SIGTERM by hand. The supervisor now stamps its process-start pin next to its pid in the `state.toon` heartbeat, so ONE identity is published to two anchors; `discoverLiveSupervisorPid` falls back to the snapshot when the lock cannot answer, the stale-state reaper and the watchdog honour the same anchor (so a live lane is never wiped and never respawned over), and `fleet_status` names the anchor that answered in a new `supervisor.identity_anchor` field.
