---
title: feat(afk): half-open circuit breaker for parked slots (#628)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-731]
pr: 731
merge_sha: 74fcdcc6c33d1ad589e98e32db846a4e76fcbd1c
---

# feat(afk): half-open circuit breaker for parked slots (#628)

- **PR:** [#731](https://github.com/reddb-io/red-skills/pull/731)
- **Author:** @filipeforattini
- **Merge SHA:** `74fcdcc6c33d1ad589e98e32db846a4e76fcbd1c`
- **Format:** merged pull request

## Summary

Pure `slot-circuit.ts` state machine wired into the fleet supervisor — parked slots probe with exponential back-off cooldown instead of staying parked forever.

## What's in

- **`apps/dev/src/core/slot-circuit.ts`** — pure, clock-injected module: `tripCircuit`, `nextTripEpoch`, `isHalfOpenDue`, `computeHalfOpenBackoff`, `SLOT_CIRCUIT_DEFAULTS` (base 60 s, cap 3600 s). No process/fs/clock IO.
- **`apps/dev/src/core/supervisor.ts`** — wired: parked slots schedule a retry after the current cooldown window elapses; a successful boot+claim closes the circuit; fast-death re-parks with `backoffStep++`; transitions logged on tick.
- **`apps/dev/tests/slot-circuit.test.ts`** — 19 unit tests for the pure module (injected clock, all passing).
- **`apps/dev/tests/supervisor.test.ts`** — config literals + 12 integration tests (half-open scheduling, closed on success, re-park on death).

## Gate result

`pnpm -C apps/dev typecheck` — clean. Full test suite: 1271 passed, 3 pre-existing failures (`wiring-integration.test.ts` env-specific, on `origin/main` too). Blocked:validation was a false positive: vitest teardown emits exit code 1 even when all tests pass — pre-existing on main.

Closes #628

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/731"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783834468&installation_id=129708444&pr_number=731&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F731&signature=e81a8c292769dffba391666020d5f0f178e2634334ba1a4c2be26284ad866ea1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Implemented half-open circuit breaker recovery for AFK fleet slots, enabling periodic recovery probes when slots are tripped with exponential backoff between successive failures.

* **Tests**
  * Added comprehensive test coverage for half-open state transitions, cooldown backoff calculations, and recovery probe outcomes.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): slot-circuit pure module — half-open state machine with in…
- feat(afk): half-open circuit breaker in fleet supervisor (#628)
- test(afk): add halfOpenBaseS/halfOpenCapS to test config + halfOpened…
- test(afk): unit tests for slot-circuit pure module (#628)
- test(afk): half-open circuit breaker integration tests (#628)

## Files changed

- `apps/dev/src/core/slot-circuit.ts`
- `apps/dev/src/core/supervisor.ts`
- `apps/dev/tests/slot-circuit.test.ts`
- `apps/dev/tests/supervisor.test.ts`

