# Merge latency audit: where PR-open → merged wall-clock actually goes

Research ticket: #3384 (map #3381). Sample: the last 30 merged PRs of
`reddb-io/red-skills` (#3304 … #3379, all merged 2026-08-05 UTC). Data sources:
`gh pr list --state merged`, GraphQL `timelineItems`
(`AutoMergeEnabledEvent` / `AddedToMergeQueueEvent` / `RemovedFromMergeQueueEvent`),
check-runs on each PR's head SHA and merge-commit SHA, GraphQL
`repository.mergeQueue.configuration`, and the classic branch-protection API.

## Headline numbers

| Phase (per PR) | p50 | p90 |
|---|---|---|
| **End-to-end: PR created → merged** | **15m41s** | **62m29s** |
| (a) Wait before entering the merge queue | 7m32s | 55m08s |
| — of which: created → auto-merge armed | 0m04s | 1m17s |
| — of which: armed → added to queue (PR checks + runner queueing) | 7m08s | 50m14s |
| (b+c) In-queue: added to queue → merged | 8m17s | 8m44s |
| — merge-queue `test` run (whole workspace) | 7m09s | 7m28s |
| — merge-queue `typecheck` run (parallel to test) | 1m09s | 1m12s |

**Base-update re-runs: zero.** No PR in the sample was re-added to the queue
(0 of 30 have more than one `AddedToMergeQueueEvent`) and no merge commit shows
more than one pre-merge `test` generation. Queue churn is **not** where the time
goes.

**The dominant cost is the `test` job, paid twice, serially.** The apps/dev
vitest suite runs once on the PR head (`pull_request`, p50 6m33s — required to
pass before the queue will accept the entry) and then again on the queue's temp
branch (`merge_group`, p50 7m09s). Two serial ~7-minute runs plus ~1.5 min of
queue/scheduling overhead is the structural floor: **~14–16 minutes minimum for
any PR, regardless of size.**

## Verdict on the complaint

> "A ~20-line worker PR takes ~10 min to write and ~20+ min to land."

**Essentially true.** At p50 a PR takes 15m41s from open to merge with zero
human latency (auto-merge is armed 4s after open). "20+ min" holds at roughly
p75 and above (p90 is 62m). Adding the ~10 min write time, the median
end-to-end cost of a tiny change is ~26 min, of which ~14 min is two
back-to-back runs of the same test suite. PR size is irrelevant to the floor:
#3379 (6 lines, changesets-only) had its **PR-side** `test` finish in 3 seconds
(cone-narrowed to nothing) yet still paid the full 7m04s `test` in the queue,
because `scripts/ci-affected-scope.mjs` narrowing applies only to
`pull_request` events — the `scope` job in `red-workspace-ci.yml` runs
`--whole-workspace` for every non-`pull_request` event, including
`merge_group`.

The p90 tail (50–100 min) is not the queue either: it is pre-queue wait during
parallel `/afk` drain bursts (e.g. #3304–#3310, opened within 80 minutes of
each other at 02:00–03:20 UTC), where PR-side required checks sat queued for
GitHub Actions runners, and one case (#3310) where auto-merge was armed only
31 min after open.

## Merge-queue and protection configuration (as read on 2026-08-05)

Classic branch protection on `main` (the repository ruleset named `main`
exists but its enforcement is **disabled**):

- Required status checks: **`test`** and **`typecheck`** (GitHub Actions,
  app_id 15368), `strict: true` (branch must be up to date).
- Required approving reviews: 0. enforce_admins: off. Linear history: off.

Merge queue on `main` (GraphQL `mergeQueue.configuration`):

- `mergeMethod`: **SQUASH**
- `mergingStrategy`: **ALLGREEN**
- `maximumEntriesToBuild` (build concurrency): **5**
- `maximumEntriesToMerge` (max group size): **10**
- `minimumEntriesToMerge`: **1**
- `minimumEntriesToMergeWaitTime`: **60** (irrelevant while min entries = 1)
- `checkResponseTimeout`: **3600s**

## Per-PR table

All times UTC. `preQ` = created → first `AddedToMergeQueueEvent`;
`armed→Q` = auto-merge enabled → queued (≈ PR-side required-check wall time,
including runner queueing); `queue` = queued → merged; `mgTest`/`mgTC` =
`merge_group` check-run durations on the merge commit. `—` in mgTest/mgTC
means the PR merged as part of a queue group whose checks ran on a later
entry's temp commit, so its own merge commit carries no pre-merge check runs.

| PR | +/− | created (UTC) | e2e | preQ | armed→Q | queue | re-adds | mgTest | mgTC |
|---|---|---|---|---|---|---|---|---|---|
| #3379 | 6/0 | 16:44:10 | 8m53s | 0m29s | 0m27s | 8m24s | 0 | 7m04s | 1m09s |
| #3375 | 314/0 | 16:07:04 | 16m13s | 7m54s | 7m51s | 8m19s | 0 | — | — |
| #3374 | 36/9 | 15:49:04 | 16m28s | 7m39s | 7m36s | 8m49s | 0 | 7m26s | 1m10s |
| #3360 | 238/0 | 14:49:52 | 15m30s | 7m00s | 6m56s | 8m30s | 0 | 7m17s | 1m08s |
| #3359 | 84/0 | 14:48:55 | 23m26s | 14m42s | 14m31s | 8m44s | 0 | — | — |
| #3358 | 424/0 | 14:39:51 | 6m53s | 0m04s | 0m01s | 6m49s | 0 | 5m37s | 1m09s |
| #3356 | 424/0 | 14:17:13 | 15m44s | 7m32s | 7m28s | 8m12s | 0 | — | — |
| #3348 | 28/0 | 13:41:48 | 14m47s | 6m35s | 6m32s | 8m12s | 0 | 7m08s | 1m00s |
| #3340 | 25/0 | 12:53:09 | 13m45s | 6m11s | 6m04s | 7m34s | 0 | — | — |
| #3339 | 788/4 | 12:21:59 | 14m37s | 6m24s | 6m20s | 8m13s | 0 | 7m09s | 1m11s |
| #3338 | 445/179 | 12:19:42 | 102m39s | 93m51s | 93m46s | 8m48s | 0 | — | — |
| #3328 | 25/0 | 11:38:47 | 14m53s | 6m32s | 6m30s | 8m21s | 0 | — | — |
| #3324 | 98/266 | 09:06:05 | 15m45s | 7m32s | 7m29s | 8m13s | 0 | 7m10s | 1m08s |
| #3323 | 169/49 | 08:29:02 | 15m16s | 7m35s | 6m33s | 7m41s | 0 | 6m33s | 1m09s |
| #3322 | 879/18 | 08:13:00 | 15m37s | 7m07s | 7m03s | 8m30s | 0 | 7m29s | 1m09s |
| #3321 | 313/1 | 07:36:14 | 14m33s | 7m11s | 7m08s | 7m22s | 0 | 6m19s | 1m08s |
| #3320 | 495/209 | 05:52:30 | 19m14s | 10m30s | 10m27s | 8m44s | 0 | 7m32s | 1m14s |
| #3319 | 732/231 | 05:32:15 | 15m38s | 7m42s | 7m39s | 7m56s | 0 | 6m53s | 1m14s |
| #3318 | 161/48 | 05:25:44 | 39m03s | 30m39s | 29m21s | 8m24s | 0 | 7m15s | 1m07s |
| #3317 | 60/73 | 05:10:48 | 14m34s | 6m21s | 5m04s | 8m13s | 0 | — | — |
| #3316 | 75/232 | 04:35:13 | 15m49s | 7m32s | 7m24s | 8m17s | 0 | 7m16s | 1m06s |
| #3315 | 230/84 | 04:17:08 | 26m26s | 18m42s | — | 7m44s | 0 | 7m02s | 1m09s |
| #3313 | 171/13 | 04:00:38 | 13m50s | 5m38s | 4m54s | 8m12s | 0 | 7m05s | 1m13s |
| #3312 | 175/43 | 03:32:58 | 16m06s | 7m48s | — | 8m18s | 0 | — | — |
| #3310 | 169/63 | 03:20:40 | 106m58s | 98m35s | 67m38s | 8m23s | 0 | 7m13s | 0m54s |
| #3309 | 15/4 | 03:07:43 | 59m22s | 51m57s | 51m35s | 7m25s | 0 | 6m47s | 1m10s |
| #3308 | 6/8 | 02:29:55 | 90m34s | 83m55s | — | 6m39s | 0 | 5m45s | 1m10s |
| #3306 | 184/55 | 02:22:04 | 58m14s | 49m42s | 49m21s | 8m32s | 0 | 7m29s | 1m12s |
| #3305 | 12/7 | 02:10:49 | 15m13s | 6m49s | 6m39s | 8m24s | 0 | 7m15s | 1m06s |
| #3304 | 191/115 | 01:59:14 | 14m56s | 6m21s | 2m58s | 8m35s | 0 | 7m21s | 1m10s |

Three PRs (#3315, #3312, #3308) carry no `AutoMergeEnabledEvent` in the
sampled timeline item types; their pre-queue split is left `—`.

## Per-check durations

Only `test` and `typecheck` are branch-protection-required. The rest report
but gate nothing.

`merge_group` runs (on the queue temp branch; n = 22, the group-tail merges):

| Check | n | p50 | p90 | max |
|---|---|---|---|---|
| test | 22 | 7m09s | 7m28s | 7m32s |
| typecheck | 22 | 1m09s | 1m12s | 1m14s |
| workflow-security | 22 | 0m11s | 0m13s | 0m15s |
| scope | 22 | 0m08s | 0m09s | 0m11s |

`pull_request` runs (on PR head SHAs; n = 33 successful runs across the 30 PRs):

| Check | n | p50 | p90 | max |
|---|---|---|---|---|
| test | 33 | 6m33s | 7m20s | 7m42s |
| typecheck | 33 | 1m08s | 1m14s | 1m17s |
| benchmark | 5 | 0m21s | 0m25s | 0m27s |
| workflow-security | 33 | 0m12s | 0m13s | 0m15s |
| Skill first-line bold check | 33 | 0m11s | 0m13s | 0m15s |
| scope | 33 | 0m09s | 0m10s | 0m15s |
| plugin-structural-smoke | 33 | 0m08s | 0m09s | 0m11s |
| validate-marketplace | 10 | 0m07s | 0m09s | 0m10s |
| label | 26 | 0m04s | 0m05s | 0m07s |

Note the PR-side `test` p50 (6m33s) is pulled down by cone-narrowed runs
(a changeset-only PR reports `test` success in 3s); the `merge_group` `test`
never narrows, which is why its distribution is tight around 7m10s.

## In-queue anatomy (typical entry)

For #3379 (representative): queued 16:44:39 → temp-branch checks started
16:45:07–16:45:27 (~30–50s pickup) → `test` 16:45:27–16:52:31 (7m04s) →
merged 16:53:03 (~30s merge dispatch after the last required check). The queue
adds roughly 60–90s of overhead on top of the `merge_group` `test` wall time;
`typecheck` (1m09s) is fully shadowed by `test`.

## Where the minutes actually are (decision inputs, not decisions)

1. **`test` is ~85% of every gate run** (7m09s of the 8m17s queue p50; 6m33s
   of the 7m32s pre-queue p50). Everything else is seconds.
2. **The suite runs twice serially per merge** — once as queue-admission
   (`pull_request`) and once as queue-validation (`merge_group`). With
   `strict: true` + a merge queue, the PR-side required run is redundant with
   the queue-side run in gating power, but it is what admission waits on.
3. **`merge_group` always pays whole-workspace** — the cone narrowing in
   `red-workspace-ci.yml` deliberately covers `pull_request` only, so even a
   6-line changeset PR pays the full 7-minute suite in the queue.
4. **The queue itself is healthy**: ALLGREEN with build concurrency 5, zero
   re-adds and zero base-update re-runs in 30 merges; in-queue p90 (8m44s) is
   barely above p50 (8m17s).
5. **The e2e p90 tail is runner contention during drain bursts**, not the
   queue: concurrent worker PRs queue their admission `test` runs behind each
   other on GitHub-hosted runners.
