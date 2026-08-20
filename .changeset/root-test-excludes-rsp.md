---
"@reddb-io/red-skills": patch
---

The root `test` aggregate excludes `@reddb-io/rsp`, matching the #3878 CI
posture: rsp's broad gates were removed from CI, but the same aggregate ran
inside every Worker's local gate whenever a branch touched a root-level file
(every changeset does), and rsp's resident suite is red without REDDB_BIN —
so whole Tickets gate-blocked on a suite CI decided not to run.
