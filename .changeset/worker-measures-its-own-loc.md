---
"@reddb-io/worker": patch
"@reddb-io/redskilled": patch
"@reddb-io/redskilled-render": patch
"@reddb-io/dev": patch
---

statusline: the Worker measures its own `loc=+X -Y` and pulses it

`loc=` is the one cell on the Worker row that answers "is this Worker producing anything", and it was the one cell #4286 could not restore — the daemon holds no checkout, so deriving the pair its own way would be a git walk per render. That is right about the render path and wrong about where the measurement belongs: the Worker is standing in the Worktree.

- **The Worker measures, once per stage transition.** `measureWorktreeDiff` (`packages/worker/src/acp/worktree-diff.ts`) asks `git merge-base` and then a single `git diff --numstat` from that commit to the WORKING TREE, so committed rounds and the round the implementer is still typing are counted together, each line exactly once. Two diffs summed would double-count every line a later edit touched again, and the cell would climb while the branch stood still. The read is bounded (`WORKTREE_DIFF_TIMEOUT_MS`) and every failure returns `null`; a measurement that could delay a stage is not taken.
- **The pair rides the route `phase` and `step` already take.** `TicketLoopRecord` gains `diff`, which the loop fills from a new `measureDiff` dep as each stage resolves — "the gate passed" and "the gate passed on +1394 -7397" are different facts, and the second is the useful one. `notifyTicketStage` puts it on the SAME `_meta.redskills.ticketStage` object, so no ACP field and no second channel was added; `sessionUpdateStage` parses it, the pulse carries it, and `applyWorkerPulse` folds it onto the display.
- **`loc=` is a Worktree fact, and the Worktree outlives the agent.** The cell was gated behind the renderer's `noAgent` rule beside `tks=`/`tls=`/`rsn=`/`txt=`, which count what an agent did this turn. Under ADR 0148 `gate` and `land` are stages the Worker runs, with the diff it just committed sitting right there, so the gate blanked the cell for three of the loop's five stages. The four counters keep the rule; `loc=` does not.
- **Absent still means unmeasured.** `loc=0` is a Worker that has produced nothing; no cell at all is a Worker nobody measured, and the two are never spelled the same way.

`applyWorkerPulse` moves the pulse fold out of the daemon's lifecycle closure and beside the display type it builds, which retires the last `DAEMON_BOUNDARY_ALLOWANCES` entry.
