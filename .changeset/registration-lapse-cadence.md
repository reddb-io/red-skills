---
"@reddb-io/red-skills": patch
---

The registration tests declare the cadence that retires a lapsed registration

#3802 made host-state and statusline reads pure snapshots and, in the same work,
removed the sweep from the read path and added the test that pins that purity.
Three tests in `mcp-project-registration` were left behind: they register with a
20ms window, wait 40ms, and expect the lapse to be observable — with its
`lapsed_at` and its "nothing renewed it" reason, both of which only exist once
the registration is RETIRED.

With reads pure, the only thing that retires one is the independent belt, and
the belt's production cadence is 60 seconds. So the tests were asserting against
a sweep that had not run — against a deadline they never declared.

They declare it now. The cadence was already an option; nothing on the read path
or in the daemon's behaviour changes.
