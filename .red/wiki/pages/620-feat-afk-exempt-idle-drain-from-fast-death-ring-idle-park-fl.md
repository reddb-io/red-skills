---
title: feat(afk): exempt idle drain from fast-death ring, idle-park fleet on empty queue
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-620]
pr: 620
merge_sha: c10cda084e8de857ede7c0679cb287a472144fd2
---

# feat(afk): exempt idle drain from fast-death ring, idle-park fleet on empty queue

- **PR:** [#620](https://github.com/reddb-io/red-skills/pull/620)
- **Author:** @filipeforattini
- **Merge SHA:** `c10cda084e8de857ede7c0679cb287a472144fd2`
- **Format:** merged pull request

## Summary

## Summary

Fixes #578 (parent: #567).

- A clean drain (exit 0 / NO_MORE_TASKS) is now exempt from the fast-death ring: K consecutive drains can never trip the circuit breaker
- An empty queue causes idle-park (`slot.idleParked = true`) with no sweep, no discard envelope, and no breaker recording
- When the queue refills, `superviseTick` un-parks idle-parked slots and spawns a new worker immediately
- The `spawning` flag set around every `spawnSlot` await prevents a double-spawn when an enclosing tick is abandoned by the `guardedTick` ceiling before the spawn resolves

## Acceptance criteria

- [x] A clean drain (exit 0 / NO_MORE_TASKS) is not counted as a fast-death
- [x] An idle fleet does not park its slots; a refilled queue is picked up
- [x] Respawn is gated on ready-queue depth and a parked slot can un-park
- [x] An abandoned (timed-out) tick does not double-spawn a slot
- [x] Tests cover idle-drain-does-not-trip and exit-0-not-fast-death

## Test plan

- `tests/supervisor.test.ts` — 54 tests (all passing), including new describe blocks:
  - `idle-drain: exit 0 idle-parks without tripping the circuit breaker` (6 tests)
  - `spawning guard: prevents duplicate spawn when tick is abandoned mid-spawn` (2 tests)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/620"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783654419&installation_id=129708444&pr_number=620&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F620&signature=3608f0003533d043ec2ed27efbfdaeb485f29f28518290e2ad605a9721638aba"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Enhanced worker lifecycle management with per-worker exit code tracking and idle state detection.
  * Improved queue monitoring with real-time depth tracking per supervisor tick.

* **Bug Fixes**
  * Prevented duplicate worker spawning during interrupted operations.

* **Tests**
  * Expanded test coverage for idle drain behavior and spawn guard mechanisms.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): exempt idle drain from fast-death ring, idle-park fleet on…

## Files changed

- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/tests/supervisor.test.ts`

