---
title: feat(afk): supervisor tick dispatches reconcile workers for parked-mechanical issues
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-564]
pr: 564
merge_sha: 0526b0f07ea52f5c43655a823fc645efbde7deba
---

# feat(afk): supervisor tick dispatches reconcile workers for parked-mechanical issues

- **PR:** [#564](https://github.com/reddb-io/red-skills/pull/564)
- **Author:** @filipeforattini
- **Merge SHA:** `0526b0f07ea52f5c43655a823fc645efbde7deba`
- **Format:** merged pull request

## Summary

## Summary

- Adds cheap parked-mechanical detection (`findReconcileCandidate`) to the supervisor tick: one gh label query + remote branch list, well under `RED_AFK_TICK_TIMEOUT_S`
- Dispatches a reconcile worker (`run --once --reconcile-issue <n>`) into the first free slot when a candidate is found — typically a stall-reaped slot within the same tick
- Heavy validate+land runs in the worker process (its own timeout), off the tick's critical path

## Changes

- **supervisor.ts**: `ReconcileCandidate` type; optional `spawnReconcileWorker` on `SupervisorProc`; optional `findReconcileCandidate` on `SupervisorGh`; `reconciledSlots` on `TickResult`; exported `dispatchReconcileIfPossible`; step 4 in `superviseTick`; updated `continueResult`
- **supervise.ts**: wires `spawnReconcileWorker` (spawns `run --once --reconcile-issue <n>`) and `findReconcileCandidate` (`listParkedMechanicalCandidates` + `listRemoteBranches` + `planReconcileSweep`) into real `SupervisorDeps`
- **gh.ts**: `viewIssueFull` — single-issue fetch for the reconcile worker mode
- **run.ts**: `--reconcile-issue <n>` flag + `runReconcileWorker` — bypasses boot+session and calls `makeBootReconcileRunner` for the specific issue without re-running the agent

## Test plan

- [ ] All 1148 tests pass (`pnpm --filter dev test`)
- [ ] Type-check clean (`npx tsc --noEmit` in `src/apps/dev`)
- [ ] 10 new tests in `supervisor.test.ts`: dispatch decision (no deps, all busy, no candidate, throw swallowed, free slot, slot accounting) + `superviseTick` integration (stall-reap → dispatch, stall-reap → no candidate)

Closes #562

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/564"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783547150&installation_id=129708444&pr_number=564&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F564&signature=aa4c0616d77396c9280fb92ffd248c3d78c4e4542686c8c8b48cf1ead35b9076"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): supervisor tick dispatches reconcile workers for parked-me…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/src/runtime/gh.ts`
- `src/apps/dev/tests/supervisor.test.ts`

