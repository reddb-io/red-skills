---
"@reddb-io/red-skills": major
---

The janitor is deleted: nothing auto-deletes inside a client checkout

ADR 0149 §4 moved Worker workspaces into daemon-placed OS temporary storage, and
this removes the cleaner that existed because they used to share a directory with
a human's work. Gone: the tmp janitor (planner and runtime), the worker and
worker-state reclaim planners, the workspace-retention collector, the boot phase
that ran them, the monitor's read-time teardown, and the feedback-lane audit that
only the janitor could answer.

**A renderer that deletes is how a stale read becomes a deletion** — the monitor
now only reads. The daemon reaps what it births, and its evidence lane keeps what
a human needs to rescue orphaned work.

`branch-reclaim` survives: it plans over branches on the forge, not directories
in a checkout, and was never the janitor's concern.
