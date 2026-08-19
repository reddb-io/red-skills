# /afk Troubleshooting

Use these playbooks when `/afk` reaches a confusing terminal state. Follow the `writing-for-agents` TROUBLESHOOTING convention: Symptom -> Confirm -> Recover -> Root fix.

## Gate census when ready-for-agent is empty

### Symptom

`/afk` reports zero `ready-for-agent` issues while the open non-Spec backlog is
not empty.

### Confirm

1. Read the queue with the rs_dev `queue_status` tool, and the live workers with
   `monitor` — both are read tools, free to call. No-MCP fallback:
   `npx -y -p @reddb-io/red-skills@<version> red-skills-dev monitor --once`.
2. Compare `ready-for-agent` with open non-Spec issues in the issue tracker.
3. Census the gates by label family: `blocked:dependency`, `needs-triage`,
   `ready-for-human`, `type:spec`, and any unsupported `blocked:*` label.
4. For each `blocked:dependency`, inspect every `req:N` target. A delivered but
   still-open Spec can strand dependents even when the dependency is complete.

### Recover

1. Do not stop as a clean drain while executable backlog remains.
2. Clear the highest-leverage false gate first: finish triage, close delivered
   dependency targets, resolve stale human parks, or move eligible work back to
   `ready-for-agent`.
3. Re-run the queue view after each batch and continue until every open
   executable issue is either agent-ready or gated for a real pending reason.

### Root fix

This manual census is a stopgap for the queue reconciler tracked in #1739.

## False main-red verification

### Symptom

Validation claims `main` is red, but the failure appears only in a local or
agent-specific probe environment. A genuine failure reproduced on a healthy
baseline can park one branch with an `inconclusive` comparison. A baseline that
could not be built is different: it is INFRA, its failure is not cached, and a
later round retries it without charging or Re-seeding the implementer. The
main-red repair lane is retired, so neither result is a tracked issue or global
land block.

### Confirm

1. Check the actual GitHub Actions runs for `main`, not only the local command
   tail.
2. Check whether recent release tags were cut from the same `main` lineage.
3. Re-run the exact configured gate command. Do not add wider target sets,
   stricter flags, or extra lint rules.
4. If the exact gate is green and the stricter local probe is the only failure,
   classify the finding as a probe-environment mirage.

### Recover

1. Let Verdict spend one environment-ledger round to re-materialise the baseline
   and rerun for free. If repetition or ledger exhaustion parks it, close that park
   only with concrete evidence: current `main` CI state, relevant release tag,
   and the exact gate command that passed.
2. Link the probe-environment bug instead of blocking the validation lane on a
   check the gate does not run. Never file a "repair main" issue for it — that
   lane is retired; every problem is resolved in the PR before merge.
3. Resume or requeue the issue only after the real configured gate is green.

### Root fix

This manual verification is a stopgap for the queue reconciler and validation
authority hardening tracked in #1739.

## After-fork reversion intent finding

### Symptom

A Worker parks on `blocked:validation` with a
`red.afk.branch-reversion.v1` record. The record names `reverting_files`, a
negative `test_line_delta`, or both, and carries a structured `repair`.

### Confirm

1. Read the record's `stage`: `base-merge` inspected the feedback Worktree
   immediately after it corrected a stale base; `landing` is the final net on
   the integrated tree before a PR opens or the base is written.
2. Inspect `fork_point`, `reverting_files`, and `test_files_shrunk`. A reverting
   file deletes lines that reached the base after that fork; the test ratchet
   independently refuses an undeclared decrease in test-source lines.
3. Check `declarations`. A path-specific issue-body deletion statement covers
   only the named path; an explicit `contract phase: remove ...` statement (the
   #3266 shape) covers the contract deletion and is retained verbatim as its
   citation. Problem prose or a prohibition on deletion is not a declaration.

### Recover

1. If the deletion was accidental, run the record's pasteable `repair.command`.
   It is composed as `git checkout origin/<base> -- <exact flagged files>` and
   restores only `repair.files`.
2. Reconcile any legitimate branch edits in those files, commit the repair, and
   re-run the same gate. Never auto-apply the checkout: restoring a whole file
   can discard intentional edits, which is why this is an intent finding.
3. If the deletion is intentional, add a precise deletion declaration to the
   Ticket body (name the paths when the intent is path-specific), then requeue.
   The next passing record cites the declaration used.

### Root fix

The two deterministic barriers and test-line ratchet are the root fix in #3279;
adversarial review remains complementary and is not required for this check.

## Scout and worker salvage after crashed or no-sentinel runs

### Symptom

An attempt is marked crashed or no-sentinel, but the worker lane may contain a
completed report, useful notes, or finished work.

### Confirm

1. Inspect the attempt log and grep for `<promise>DONE</promise>` or
   `<promise>BLOCKED</promise>` in the Worker's `worker.log.toonl`.
2. Read the final `kind=text` records from that same Worker log and find the
   last useful agent message.
3. Check whether the branch contains unique commits or an uncommitted diff.
4. Distinguish envelope failure from real failure: a completed report or DONE
   followed only by sentinel handling failure is salvageable; an explicit
   unresolved blocker remains blocked.

### Recover

1. For scout reports, post the sanitized report to the disposable scout issue
   and close it. Scout work has no PR to land.
2. For worker branches with useful commits, salvage the branch through the
   normal PR and CI path.
3. For no useful work, close the disposable issue with the sanitized evidence
   and requeue the original tracked issue.
4. Record recurrence against the root-fix issue so repeated envelope failures
   are visible.

### Root fix

This manual salvage is a stopgap for the scout and worker envelope hardening
tracked in #1695.

## Park-resolution contract

### Symptom

An issue's labels are flipped out of a parked state without a matching
`## Current blocker` update, or the blocker block is edited while labels still
claim the old state.

### Confirm

1. Read the issue body and find the `## Current blocker` block.
2. Compare the blocker kind with the live labels: `ready-for-human`,
   `blocked:*`, `ready-for-agent`, and any `req:N` dependency edges.
3. Check comments for a HITL directive or maintainer decision that resolves the
   parked reason.

### Recover

1. Use `hitl_resolve` for the requested `requeue`, `retake`, or `park`
   transition. It treats the body as authoritative and projects labels from it.
2. A body with no active `red:blocker-state` sheds stale `blocked:*` labels. An
   active body blocker rewrites a stale typed label to `blocked:<body kind>`.
3. Never perform a raw label-only requeue or unblock. The issue body is the
   durable contract that explains why the labels changed.

### Root fix

This paired-update procedure is a durable manual procedure. The broader
automation reconciliation is tracked in #1739.

## Base-stale decision procedure

### Symptom

An issue or PR is parked as `base-stale`, or an old AFK branch exists after
`main` has moved.

### Confirm

1. Fast-forward local `main` from origin before comparing branches.
2. Find the parked branch and compute its merge-base with current `main`.
3. Inspect commits unique to the parked branch. Also check for uncommitted
   worker artifacts if the worker directory still exists.
4. Decide whether the branch contains user-facing work, only generated churn, or
   no unique work.

### Recover

1. If unique work exists, adopt it through a normal branch, PR, and CI run
   against current `main`.
2. If the branch is empty or contains no useful work, do a plain requeue of the
   tracked issue instead of preserving the stale branch.
3. If generated churn obscures the decision, isolate the human-authored files
   and document what was kept or discarded.

### Root fix

This decision tree is a durable manual procedure. Automatic stale-branch
reconciliation remains part of the broader reconciler tracked in #1739.

## Requeue escalation map

### Symptom

A parked issue carries `blocked:<kind>` outside the supported automatic requeue
set, or a HITL card refuses `/requeue` for that blocker kind.

### Confirm

1. Identify the exact blocker label and the issue body's `## Current blocker`.
2. Try the narrowest supported CLI verb first when one exists, such as `/afk
   retake N` for resumable AFK work.
3. If the CLI cannot act, inspect the HITL card for supported comment verbs:
   `/approve`, `/approve-ci`, `/reject`, and `/requeue`.
4. If the card rejects the blocker kind, classify it as a full-contract manual
   resolution rather than repeating the same unsupported command.

### Recover

1. Use the CLI verb when the blocker kind is supported.
2. Use a HITL card comment verb when the card supports the transition.
3. For an inconsistent or formerly unsupported `blocked:<kind>` label, use
   `hitl_resolve`: a resolved body blocker can requeue, while `park` either
   projects the declared body kind or plainly refuses when no coherent label
   counterpart exists.
4. Re-run the gate census so the issue returns to the correct lane.

### Root fix

This escalation map is a stopgap for unsupported blocker reconciliation tracked
in #1739.

## Release-pipeline playbook

### Symptom

The release pipeline does not publish the expected fix, or a change needs a
release trigger even though the code diff is already on `main`.

### Confirm

1. Check conventional-commit bump rules for the merged commits. A `fix:` commit
   should trigger a patch release; `feat:` should trigger a minor release.
2. Check whether AFK fleet workers are still running. Defer release-trigger
   commits while fleet activity could race with branch or tag state.
3. If no bump-worthy commit exists for an already-merged fix, prepare an empty
   `fix:` trigger commit that references the issue.
4. After the release appears, verify the fix-in-tag with an ancestor check from
   the release tag back to the fixing commit.

### Recover

1. Wait for fleet workers to drain before creating release-trigger commits.
2. Use an empty `fix:` commit only when the code change is already present on
   `main` and the release pipeline needs a conventional-commit signal.
3. Verify the published tag contains the fix before closing the release lane.
4. If the tag does not contain the fix, stop and repair the release lineage
   instead of announcing success.

### Root fix

This playbook establishes the documentation contract for release troubleshooting
in #1863; the durable release policy remains the conventional-commit pipeline.

## Fleet stop and takeover verification

### Symptom

A fleet supervisor was stopped, killed, relaunched, or watchdog-respawned, and
you need to prove whether workers were cleanly stopped or adopted by the new
supervisor.

### Confirm

1. Call the `rs_dev` MCP's `status {scope: project}` and read the registration, target,
   slot counts, and live worker list.
2. Check `.red/tmp/supervisors/default/state.toon` for `slot_pids`. A relaunched
   supervisor uses this map to adopt live detached workers into their original
   slots before spawning replacements.
3. For a clean stop, verify `afk-supervisor.pid` is gone and no live worker pids
   remain under `.red/tmp/workers/*/worker.pid`.
4. For takeover, compare the pre-relaunch `slot_pids` with the post-relaunch
   state: live pids should remain in slots, dead pids should disappear, and
   `spawns_this_tick` should fill only the missing remainder.
5. Check `.red/state/castle/supervisors/` for stale `s<PID>` snapshot dirs. Dead
   supervisor dirs should be removed on the next supervisor boot.

### Recover

1. Prefer the `rs_dev` MCP's `project_stop` for a clean stop; it gives the
   registration back, waits for the workers it attributed, then sweeps detached orphans.
2. If the supervisor died unexpectedly, let the `fleet` command or the
   watchdog relaunch it. The relaunch should report why it respawned, including
   ready work stranded and live workers versus target.
3. If live workers were not adopted, stop the fleet, verify no pids remain live,
   then relaunch from a clean state.
4. If stale supervisor dirs remain in the red-castle state lane after boot, remove only dead `s<PID>`
   dirs after confirming the pid is not live.

### Root fix

Supervisor snapshots persist slot pids so takeover is automatic. This playbook
is the manual verification path for #2067 and should stay aligned with the
state snapshot contract.

## Fast-death taxonomy

A "fast death" is any worker exit the circuit breaker counts within its window
(`CIRCUIT_K` deaths inside `CIRCUIT_WINDOW_S`). These are the named classes:

- **stale-claims boot crash (dominant)**: Worker boots, reads a poisoned
  stale-claim file, and dies before the sandcastle spawn directory is created
  (`{issue}-{worker}/` absent from the worker dir). Signature: worker dir
  contains only `worker.pid`, no spawn subdirectory, +0/-0 diff. Not OOM, not
  quota. Cured by purging the stale claim and rebooting the fleet.

- **gh rate-limit misread as auth failure**: A transient GitHub API rate-limit
  burst makes `gh auth status` exit non-zero, tricking the boot pre-check into
  reporting "gh not authenticated". Fixed — `ghAuthenticated` now discriminates
  report text so a transient rate-limit never bricks the fleet.

- **host-config: missing interpreter or cwd (terminal, non-retryable)**: Worker
  spawn fails with `spawn sh ENOENT` (no POSIX shell on PATH) or `cwd does not
  exist`. Previously mis-classified as `runner-transient`, which caused the
  cooldown circuit to retry a permanent host defect indefinitely. Now classified
  as `host-config` — no retry is scheduled, the terminal envelope names the
  defect, and the issue is released back to the queue. Fix the host environment
  (install or restore `sh`; confirm the configured workspace path exists) and
  rerun.
