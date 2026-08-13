---
"@reddb-io/red-skills": patch
---

The unblock sweep says why it did not promote

A dependency gate stayed shut with its only blocker closed: #3801 carried
`req:3800`, #3800 was closed and its `## Blocked by` checkbox was already
ticked, and three `unblock_sweep` runs answered `promoted: []`.

An empty list was the sweep's entire vocabulary, so three different situations
arrived as one indistinguishable silence — no candidate carried the label, a
blocker still reads open, or the state transition was refused. Diagnosing it
meant running the core by hand: the pure planner turned out to be correct, the
IO reads turned out to be correct, and calling `runRepoUnblockPass` directly
promoted the issue on the first try. Three probes to learn what the tool could
have said in one line.

Every path that declines to promote now says so. The planner names the blockers
it could not confirm closed — by number, so an operator can check them against
the tracker — and says when a candidate declares nothing to wait for at all. The
executor's one silent exit, a refused state transition dropped with no record
anywhere, reports the refusal and its reason. A promotion states the lane it
routed to.

`unblock_sweep` answers `{promoted, outcomes}`; `promoted` keeps its meaning for
every existing caller. A blocker that did not answer is reported exactly like
one still open, because the closure lookup cannot tell them apart and the sweep
holds either way — that is the conservative direction, and now a stated one.
