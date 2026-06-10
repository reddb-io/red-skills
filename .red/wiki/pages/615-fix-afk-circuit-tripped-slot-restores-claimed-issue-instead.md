---
title: fix(afk): circuit-tripped slot restores claimed issue instead of stranding it
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-615]
pr: 615
merge_sha: 934a572b1345f6eeede07cf10a0c00613b541872
---

# fix(afk): circuit-tripped slot restores claimed issue instead of stranding it

- **PR:** [#615](https://github.com/reddb-io/red-skills/pull/615)
- **Author:** @filipeforattini
- **Merge SHA:** `934a572b1345f6eeede07cf10a0c00613b541872`
- **Format:** merged pull request

## Summary

## Summary

Fixes #577. The parked-slot trip sweep was dead code in the native fleet — a tripped slot always stranded its claimed issue in `running` forever.

**Three bugs fixed together:**

- **Primary:** `parkedSlotWorkFor` read worker IDs from a per-slot log file that the native supervisor never wrote the `[afk] worker:` boot-stamp to, so the parse always returned `[]` and `sweepParkedSlot` returned early. Added a PID-based fallback: when the log yields no workers, resolve the last worker via `findSlotIterDir(tmpDir, lastPid)` + `worker.pid` match — the real path the native fleet always takes.
- **Hidden:** The `root` arg passed to `iterDirsForWorker` was the git root, not `tmpDir` (workers live under `.red/tmp/workers/`), so even a boot-stamp would have missed the iter dirs. Fixed by removing the wrong parameter — both paths now use `tmpDir`.
- **Threading:** `sweepParkedSlot` now passes `state.pid` (the dead worker's last known PID) to `parkedSlotWork` so the fs layer has it for the fallback lookup.

The discard-envelope fast-death count (`state.deaths.length` at trip time) was correct in the code but unreachable because the early-return fired first; fixing the sweep makes it live.

## Test plan

- [x] All 1153 existing tests pass (`pnpm --filter dev test`)
- [x] New integration tests in `supervisor-fs.test.ts` exercise `parkedSlotWorkFor` over real disk via the PID-based path (no slot log, `worker.pid` match): claimed issue resolved, pre-claim null, non-matching PID → empty, null PID → empty, log path takes precedence over PID path
- [x] New test in `supervisor.test.ts` verifies `handleDeadSlot` threads `state.pid` through to `parkedSlotWork(slot, pid)` during a trip sweep

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/615"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783643984&installation_id=129708444&pr_number=615&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F615&signature=ac2c621c8677acf414b3660bbf92b380084ab0277b3010acd1b0f943ef7f62ca"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Worker processes now maintain individual log files per execution slot for improved isolation and diagnostics.

* **Improvements**
  * Supervisor now derives worker health metrics from runtime state instead of relying solely on persisted metadata.
  * Enhanced worker identification logic with process ID-based fallback for improved robustness when slot logs are unavailable.

* **Tests**
  * Added comprehensive test coverage for worker identification and supervisor state tracking across multiple resolution scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): circuit-tripped slot now restores claimed issue — fixes str…
- fix(afk): circuit-tripped slot now restores claimed issue — fixes str…

## Files changed

- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/src/runtime/supervisor-fs.ts`
- `src/apps/dev/tests/supervisor-fs.test.ts`
- `src/apps/dev/tests/supervisor.test.ts`

