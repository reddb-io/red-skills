---
"@reddb-io/red-skills": patch
---

A dead Worker's empty lane is no longer immortal

The worker-directory janitor asked two questions of every lane — is every
represented issue closed, and has an open-issue lane outlived its TTL — and both
gate on the lane having at least one parseable issue child. A lane with none
answered `false` to both and was spared at ANY age, forever.

That is the common end state, not an edge case: a Worker whose workspaces were
already reclaimed, or that died before claiming anything, keeps only its log and
its pid file. Seventy-six such lanes were being reported as workers on one host
while this sweep ran every five minutes and freed none of them.

An aged, empty lane whose Worker the daemon calls dead is now reclaimed on the
same 45-day TTL an open-issue lane already uses. Two things are deliberately
unchanged: a FRESH empty lane is still spared, because a Worker that has just
died still owns evidence somebody may be reading, and a lane the daemon cannot
answer for is still spared at any age — only a fresh `dead` verdict releases
one, never the absence of a pid file.

This bounds the growth rather than shrinking it today: on a host measured while
writing this, all twenty empty lanes were hours old, so none was yet eligible.
The defect was that they would never have become eligible at all.
