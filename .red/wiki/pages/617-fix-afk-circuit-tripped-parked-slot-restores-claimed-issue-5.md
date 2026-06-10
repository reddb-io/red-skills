---
title: fix(afk): circuit-tripped parked slot restores claimed issue (#577)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-617]
pr: 617
merge_sha: 7ee42a1271b032c545626eb578da606c2eb2bafd
---

# fix(afk): circuit-tripped parked slot restores claimed issue (#577)

- **PR:** [#617](https://github.com/reddb-io/red-skills/pull/617)
- **Author:** @filipeforattini
- **Merge SHA:** `7ee42a1271b032c545626eb578da606c2eb2bafd`
- **Format:** merged pull request

## Summary

## Summary

Fixes three interlocked bugs that made the circuit-trip sweep a dead-code no-op in the native fleet, leaving any claimed issue permanently stuck in `running` after a slot was parked.

**Bug 1 (supervise.ts):** `spawnSlot` routed all slots to a single shared `logFd`, so `parseWorkerIdsFromLog` always read a missing/wrong file and returned `[]`. Each slot now opens its own `afk-supervisor-slot-{n}.log` (append, fd closed in parent after spawn), mirroring `supervisor.sh`'s `spawn_slot` per-slot `slot_log`.

**Bug 2 (supervisor-fs.ts):** `parkedSlotWorkFor` had no fallback when the slot log yields no workers. Added a PID-based fallback: when the log is empty, resolve the last worker via `findSlotIterDir(tmpDir, lastPid)` + `worker.pid`. Also fixed a latent bug where `iterDirsForWorker` received the git root instead of `tmpDir` (workers live under `.red/tmp/workers/`). `sweepParkedSlot` now threads `state.pid` through for the fallback lookup.

**Bug 3 (run.ts):** Workers that crash before writing `worker.pid` (e.g. during `collectBootOptions`) were invisible to both paths. Fixed by emitting `[afk] worker: wXXXX` to stdout immediately after generating the worker ID — the supervisor routes the child's stdout/stderr to the per-slot log, so the stamp is captured even on fast death before any I/O.

**Fast-death count:** The discard envelope always reported 0 fast deaths because the early-return fired before reaching the count derivation. The count was already correct (`state.deaths.length`) — fixing the sweep makes it live.

## Acceptance criteria
- [x] When a slot's circuit breaker trips, the claimed issue is restored to the queue (or paged), never left stranded in `running`
- [x] The parked-slot work resolution is exercised by an integration test over the REAL path (current coverage injects a fake and never runs it)
- [x] The trip-sweep discard envelope reports the true fast-death count

## Test plan
- [ ] All existing 1155 tests pass (`pnpm test` in `src/apps/dev`)
- [ ] `supervisor-fs.test.ts`: new real-FS tests cover `parseWorkerIdsFromLog` and `parkedSlotWorkFor` (slot-log path, PID fallback, multi-worker, pre-claim)
- [ ] `supervisor.test.ts`: new integration tests exercise full `handleDeadSlot → sweepParkedSlot → real parkedSlotWorkFor → gh label restore` path; verify discard envelope carries correct fast-death count (5)
- [ ] TypeScript: `pnpm tsc --noEmit` reports no errors

Closes #577

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/617"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783646996&installation_id=129708444&pr_number=617&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F617&signature=c5d844f9bfe9ed61e7ef33705761b0bee2f4533931f58ef30dc09eb428d8993f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Supervisor now maintains dedicated log files for each worker slot, improving log organization and troubleshooting.

* **Improvements**
  * Enhanced worker ID tracking reliability to ensure identifiers are captured even if a worker process terminates unexpectedly.
  * Improved worker process identification with enhanced fallback mechanisms for better fault tolerance.

* **Tests**
  * Added comprehensive test coverage for supervisor slot management and worker operations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): circuit-tripped slot now restores claimed issue — fixes str…
- fix(afk): circuit-tripped slot now restores claimed issue — fixes str…
- fix(afk): emit worker boot-stamp on startup so circuit-trip sweep res…
- merge: main into #577 fix — resolve spawnReconcileWorker addition con…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/src/runtime/supervisor-fs.ts`
- `src/apps/dev/tests/supervisor.test.ts`

