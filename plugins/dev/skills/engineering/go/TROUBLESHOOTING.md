# /go Troubleshooting

Use these playbooks when `/go` or `/go --scout` reaches a confusing terminal state. Follow the `writing-for-agents` TROUBLESHOOTING convention: Symptom -> Confirm -> Recover -> Root fix.

## Disposable dispatch closed during Worker boot

### Symptom

A disposable `/go` or scout Ticket closes automatically because its Worker
failed during boot, before processing began.

### Confirm

1. Read the closing comment. When the Worker opened a diagnosis, the comment
   names its repository-relative path as
   `.red/tmp/diagnostics/<worker-id>-<failure-class>.log` and states the bound.
2. Open that exact file from the repository root. Boot diagnoses in this lane
   are retained for **30 days**; the tmp janitor reclaims them only after that
   age cap.
3. When the failure happened before any diagnostic lane could open, require the
   comment to say `No local diagnostics were retained`. Treat any comment that
   points at an absent file as a reporting defect.

### Recover

1. Read the retained TOON payload for its failure class, timestamp, message,
   and stack.
2. Repair the named admission, configuration, or boot precondition, then issue
   a fresh `/go` dispatch. The closed Ticket stays disposable history.
3. If the 30-day bound elapsed, reconstruct from the host event/death lanes and
   record that the local diagnosis expired; do not imply that it still exists.

### Root fix

Boot failures copy their detailed payload out of the reclaimable Worker lane
before the disposable Ticket closes. The copy lives in the bounded diagnostics
lane, while successful Workers keep the existing immediate completion sweep.

## Crashed-scout salvage

### Symptom

A `/go --scout` dispatch is reported as crashed, missing a sentinel, or closed
without the expected report comment, but the agent log shows that the scout
completed the investigation and produced a final markdown report.

### Confirm

1. Confirm the disposable issue is a scout issue, not a standard `/go` code
   issue: it should carry `lane:scout` and should not have a branch, PR, or
   mutation-bearing diff to land.
2. Inspect the scout worker lane for the attempt and find the final agent
   output. The useful signal is a completed markdown report near the end of the
   transcript, even if the outer envelope classified the run as crashed or
   no-sentinel.
3. Check that the log does not contain a real unresolved blocker after the
   report. A report followed only by envelope or sentinel handling failure is a
   salvage case; a report that explicitly says the scout could not answer is a
   real block.

### Recover

1. Copy only the scout report content into a GitHub comment on the disposable
   scout issue. Do not include local paths, hostnames, usernames, environment
   values, tokens, or agent session URLs.
2. Close the disposable scout issue after the report is posted. Scout mode has
   no PR or landing step; the report comment is the deliverable.
3. If the report found follow-up work, file or link a normal tracked issue for
   that work instead of reopening the scout lane.

### Root fix

This manual salvage is a stopgap for the scout envelope and sentinel handling
tracked in #1695. Once that root fix ships, a completed scout report must post
and close the disposable issue even when the engine envelope is imperfect.

## Engine-exit-0-but-parked reading

### Symptom

A standard `/go` dispatch exits with status 0, but the disposable issue ends up
parked, commonly with `ready-for-human`, `blocked:validation`, or a note that
looks inconsistent with the successful process exit.

### Confirm

1. Treat the process exit code as the launcher result only. It means the engine
   finished its control loop cleanly; it does not by itself mean the requested
   work landed.
2. Read the final issue labels, the worker attempt summary, and any validation
   tail carried into the parked comment. A real block names an unmet semantic
   DoD, a failed configured gate, an exhausted bounded correction retry, or an
   explicit human decision point.
3. Compare that with the final agent envelope. If the work emitted DONE and the
   only contradiction is a parse, envelope, or sentinel mismatch, classify the
   park as an envelope artifact. If the machine gate or DoD still fails, it is a
   real block even though the engine exited 0.

### Recover

1. For a real block, keep the issue parked and act on the blocker: fix the
   branch, approve or reject the human decision, or retake the issue through the
   normal lane.
2. For an envelope artifact, salvage the useful branch, report, or final notes
   from the worker lane and reconcile the disposable issue to match the actual
   deliverable state.
3. When posting public notes, describe the observable state without leaking
   local machine details or private transcript links.

### Root fix

This reading procedure is a stopgap until the `/go` outcome envelope records
separate launcher, agent, validation, and issue-state outcomes. Track this
documentation slice in #1864 and the scout envelope hardening in #1695 when the
misread involves a scout report.
