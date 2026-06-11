# AFK boot-time sweeps (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> How the bundle reclaims stale state at boot. The agent never runs these by hand — they are the bundle's startup hygiene. Referenced from *Bootstrap* and the *Per-Issue Loop* close step.

## Orphan Cleanup (boot-time)

Right after bootstrap and before *Straggler Check*, `/afk` runs two passes. First it **drain-wipes** any leftover **legacy flat** `.red/tmp/work-*/` dirs — these are never created under the nested scheme (the drain-first cutover, issue #252), so any survivor is a pre-cutover relic and is removed unconditionally. Then it sweeps the nested attempt dirs `.red/tmp/workers/*/*/` whose parent worker's `worker.pid` is dead, and afterwards removes the dead `worker.pid` files and the now-empty worker dirs. For each orphaned attempt dir:

1. **(Slice D — heartbeat sub-shell retired.)** No zombie reap step is needed; older state files may still carry a `heartbeat_pid` but it's vestigial and ignored.
2. **Decide fate from issue state.** `gh issue view N --json labels,state`:
   - `state == CLOSED` → `rm -rf`. Work landed; nothing to inspect.
   - label `ready-for-human` → **split TTL** based on `envelope.posted` in the attempt state file (see *Terminal-Event Envelope* below):
     - `envelope.posted == true` → 1-day TTL. The issue thread already carries the canonical record; the local dir is pure redundancy.
     - `envelope.posted == false` or field missing → 7-day TTL. The envelope POST failed (or this dir predates the envelope writer), so the local notes/log are the only copy.
   - label `running` (orchestrator crashed mid-issue) → restore `ready-for-agent`, post a recovery comment, then `rm -rf`. Leaving the issue eternally `running` is worse than losing the dir.
   - any other state → `rm -rf`.
3. **Fallback on gh failure.** Network / rate-limit error → fall back to mtime TTL: 7 days for dirs with a state file, 1 day for dirs without one. Conservative enough to survive transient outages without losing artefacts the human wanted.

This removes the manual "remember to clean `.red/tmp/`" discipline. Blocker dirs persist until their TTL expires; everything else self-collects on the next `/afk` run.

## Attempt Cap (boot-time, issue #257)

The *Completion sweep* (close step 11) only fires when an issue completes. Issues that **never** complete — blocked-forever work that accumulates retries — would otherwise leak attempt dirs indefinitely. Right after *Orphan Cleanup*, `cap_issue_attempts` walks every attempt dir across all workers, groups them by issue, and per issue prunes (newest attempt kept first) anything over either cap:

- **Age cap** — `RED_AFK_ATTEMPT_TTL_S` (default 14 days). An attempt dir whose mtime is older than this is reclaimed.
- **Count cap** — `RED_AFK_ATTEMPT_KEEP` (default 5). Only the newest `KEEP` attempts (by attempt number) for one issue are retained; older ones are reclaimed.

Both caps share the completion sweep's invariant: a **live** worker's active attempt (state file carrying a live `pid`) is never counted toward the cap nor removed. A non-numeric or zero env value falls back to the default so an operator typo can never disable a cap.

## Snapshot Branch Grace Cleanup (boot-time, issue #258)

The *Completion sweep* and *Attempt Cap* reclaim **local** attempt dirs; the failure-push `afk-attempts/{wid}/{N}-slug` **snapshot branches** live on origin and are the canonical record a terminal-failure envelope links to. After *Attempt Cap*, `prune_completed_attempt_branches` reaps those remote branches for issues that have **completed**: it lists `afk-attempts/*` on origin, groups branches by the issue number in the ref, classifies each issue with `gh issue view`, and:

- **still-open** issues — every branch is left untouched;
- **closed within the grace window** — kept, so a reopened issue can still recover its prior attempts from origin;
- **closed longer than the grace window ago** — every snapshot branch for that issue is deleted from origin (cross-worker).

The grace window is `RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S` (default 7 days), measured from the issue's GitHub `closedAt`. A non-numeric value falls back to the default so an operator typo can never disable the grace; `0` is honoured as "delete immediately on completion". The pass is best-effort and runs at boot, **never** on the close path — a slow or failing `gh`/`git` can never block a completion, and an issue it cannot classify is left strictly in place.

## On-Demand Branch Reaper (issue #275)

Run `/afk reap` (the bundle's `reap` command) to perform branch hygiene without starting a worker, claiming an issue, or firing lifecycle hooks. The command first prints one line:

```text
afk branch counts: remote-afk=N remote-afk-attempts=N local-afk=N
```

It then applies the same three namespace reapers used during `/afk` boot: remote `afk-attempts/*`, remote `afk/*`, and local `afk/*`. Open issues and transiently unclassified issues are kept; local branches checked out by any worktree are kept. Each successful deletion logs the branch, issue number, and classification reason. Re-running is a natural no-op once stale refs are gone. Snapshot grace still comes from `RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S`; live `afk/*` cleanup keeps the existing closed-vs-open policy.

## Fleet mode: the supervisor owns the boot (issue #623)

The sweeps above (*Orphan Cleanup*, *Attempt Cap*, *Snapshot Branch Grace Cleanup*, the *Unblock Sweep*, and the *Straggler Check*) all read and mutate **shared** `.red/tmp` / branch / `gh` state. When several workers boot at once they would race over that state — the observed failure mode was a fleet collapsing to a single live worker because peers fast-died in their boot sweeps.

So in **fleet mode** the **supervisor** runs the full sweep suite **exactly once, before it spawns any worker**, and logs the result to `.red/tmp/afk-supervisor.log` (`boot sweeps complete: orphans … | attempt-cap … | branches … | unblocked … | stragglers …`). Every worker the supervisor spawns carries a `RED_AFK_SWEEPS_DONE=1` marker; a marked worker's boot is **bootstrap + claim only** — it ensures its dirs/gitignore/`worker.pid` and goes straight to claiming an issue, skipping every shared sweep. This makes respawns cheap and keeps workers from racing each other over boot state. The supervisor runs the sweeps a single time per lifetime: a worker that exits and is respawned does **not** re-trigger them.

A **solo** `/afk run` (no supervisor, no marker) is unchanged — it runs the full sweep suite itself, exactly as described above. `/afk run --boot-only` reports which path it took: `sweeps ran` for a solo boot, `sweeps skipped (supervisor-owned)` for a marked worker.

