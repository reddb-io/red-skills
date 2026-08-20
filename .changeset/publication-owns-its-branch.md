---
"@reddb-io/worker": patch
"@reddb-io/redskilled": patch
---

A Ticket turn's publication publishes as the Worker-unique branch
(`red/<worker>/<ticket>`) regardless of the Worktree's local branch name. An
inner agent that committed on `main` published `refs/heads/main` (rejected
non-fast-forward at the canonical repository), and one that reused an old
branch name collided with the merged branch's corpse — both happened on one
Ticket in one evening.
