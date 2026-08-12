---
"@reddb-io/redskilled": minor
"@reddb-io/dev": minor
"@reddb-io/red-skills": minor
"@reddb-io/rsp": minor
---

Two-rails GitHub client and resume-repair train.

GitHub budget — the structural end of the GraphQL exhaustion incidents:

- The GitHub client rides two rails with an explicit REST/GraphQL choice per operation, per-pool budget awareness, and failover routing that never goes dark (#3663). Engine writes that have a REST equivalent leave the GraphQL pool.
- The producer sizes births from a direct label read instead of the lagging search index, ending the boot-and-die once-workers that followed every requeue (#3708).

Resume repair — a preserved worker branch can be finished again:

- Resuming an issue whose branch exists with no open PR opens the draft route itself instead of dying on the orphaned-work refusal (#3704).
- A failed feedback validation on an inherited diff becomes the agent's first work item instead of a suspect-infra park, so red WIP branches converge instead of cycling (#3705).

Host hygiene:

- The orphan reaper re-proves births from active units and worker env stamps after an event-lane rotation instead of withholding its census forever (#3706).
- Test sandboxes pin the daemon home, so suite daemons stop writing to the operator's real event lane; the outbound scrubber now redacts the union of the stated and the process home (#3707).
- The MCP host never recognizes its own bundle as the daemon entry (the exit-2 auto-spawn loop), and the daemon-entry probes refuse the mcp suffix (#3652).
- Worker liveness disproof (pid 0, dead pid) bars the live claim without hiding the worker: what cannot be proven live lands in unattributed (#3660).
- An auto-spawned daemon prefers the supervisor unit or an own scope instead of dying with the caller's terminal (#3657), and stop tells the truth about an alive daemon that misses the ping deadline (#3658).
