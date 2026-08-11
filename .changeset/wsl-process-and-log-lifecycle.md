---
"@reddb-io/redskilled": minor
"@reddb-io/dev": minor
"@reddb-io/red-skills": minor
"@reddb-io/rsp": minor
---

WSL process-explosion and log-explosion prevention (Spec #3581, 17 slices), plus the statusline remote-counter fix (#3605).

Process lifecycle — the daemon now garbage-collects what it births:

- Every Worker spawn path (transient unit, job object, POSIX, and the unisolated WSL path) stamps `RED_WORKER_ID`/`RED_WORKER_BORN_AT` and records its process group and `/proc` start time, so a surviving tree is attributable and safely killable.
- Worker teardown escalates TERM→KILL→confirm on the whole process group (`packages/shared/kill-tree.ts`) and stops forging success: an unconfirmed stop names the possibly-surviving group in its death record; daemon stops report `contained` honestly.
- A daemon-owned orphan reaper (5 min cadence) censuses the host, adopts-then-kills stamped orphan groups past a 10 min grace, reports unstamped suspects (never kills on suspicion), verifies start time before every kill, and is gated by the machine claim with a `REDSKILLED_ORPHAN_REAPER=off|report` kill-switch. Reaped deaths ride the existing birth/death event vocabulary.
- Worker units carry `TasksMax` (process-count budget also enforced for unisolated trees) and `LimitCORE=0` (with a `ulimit -c 0` wrap on the unisolated path), closing the crash-dump flood.
- Dead-worker workspaces get a two-stage TTL: 14 d worktree strip with a tombstone, 45 d full removal.

Log lifecycle — every incident lane now has a declared ceiling enforced by its writer (`packages/shared/lane-retention.ts`, tq-first trimming with a JS fallback):

- The process-death lane stops decoding itself on every exit: one stat per append, compaction only over a 4 MiB ceiling, boot pass shrinks existing lanes.
- GitHub spend ledgers (8 MiB keep-newest), castle singleton events (2 MiB), rsp telemetry spool (8 MiB, corrections 1 MiB), death attributions (1 MiB / 14 d), worker logs (50 k-line trims at quiescent points) and dev history (wired trimmer) are all bounded; dead rotation temps are swept.
- New doctor probes: `process-census` (orphans, dumps, unit inventory) with the `redskilled reap --report` operator surface, and `lane-census` (every registered lane against its declared ceiling).

Statusline: the daemon's remote-counter poll now arms correctly (#3605), so repository counters (open issues, open PRs) flow into the statusline and redskilled MCP payloads from the daemon cache.
