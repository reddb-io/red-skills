---
title: fix(afk): inject RED_AFK_SLOT per fleet slot so cargo/gradle build isolation works
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-645]
pr: 645
merge_sha: f208ffa4051f7ef2390e0c6163a37292c6848a1c
---

# fix(afk): inject RED_AFK_SLOT per fleet slot so cargo/gradle build isolation works

- **PR:** [#645](https://github.com/reddb-io/red-skills/pull/645)
- **Author:** @filipeforattini
- **Merge SHA:** `f208ffa4051f7ef2390e0c6163a37292c6848a1c`
- **Format:** merged pull request

## Summary

## Summary

- Export `buildSlotEnv()` in `supervise.ts`; use it in both `spawnSlot` and `spawnReconcileWorker` so each child process gets `RED_AFK_SLOT=<slot>`
- Extend `hookEnv()` in `hooks.ts` to accept an optional slot and include `RED_AFK_SLOT` when set
- Parse `process.env.RED_AFK_SLOT` in `run.ts` and pass it to both `hookEnv` call sites (`buildProcessDeps` + session hooks)
- Add 8 new tests covering `buildSlotEnv` (4) and `hookEnv` slot param (4)

Each fleet worker was receiving no `RED_AFK_SLOT`, causing every slot's `cargo-pre-worktree.sh` and `gradle-pre-worktree.sh` defaults to fall back to the `slot-0` path and serialize on the same build lock.

Closes #581

## Test plan

- [x] All 1233 tests pass (`pnpm test`)
- [x] `buildSlotEnv` unit tests: each slot gets its own `RED_AFK_SLOT` value, pre-existing value is overridden
- [x] `hookEnv` unit tests: `RED_AFK_SLOT` included when slot provided, omitted when not

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/645"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783686733&installation_id=129708444&pr_number=645&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F645&signature=edf38957af2f058239ebc9373e474a8b8f0bdf73043fdff03cbfbfcd83389805"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Enhanced worker process environment setup to properly track and assign fleet slots
  * Worker processes now receive correct slot-specific configuration during initialization and reconciliation

* **Tests**
  * Added test coverage verifying slot assignment propagation and environment variable injection across worker processes

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): inject RED_AFK_SLOT per fleet slot so cargo/gradle build is…

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/runtime/hooks.ts`
- `src/apps/dev/tests/runtime-hooks.test.ts`
- `src/apps/dev/tests/supervise-passthrough.test.ts`

