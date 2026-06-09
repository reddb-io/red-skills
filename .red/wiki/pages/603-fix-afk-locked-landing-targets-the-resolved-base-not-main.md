---
title: fix(afk): locked landing targets the resolved base, not main
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-603]
pr: 603
merge_sha: 9fe121d517c7efd1a94a6a591be06b2eed7f8917
---

# fix(afk): locked landing targets the resolved base, not main

- **PR:** [#603](https://github.com/reddb-io/red-skills/pull/603)
- **Author:** @filipeforattini
- **Merge SHA:** `9fe121d517c7efd1a94a6a591be06b2eed7f8917`
- **Format:** merged pull request

## Summary

## Summary
- Fixes the locked landing path so the merge and push target the resolved base (`lock > pin > main`), never a hardcoded `main`
- Updates the boot precheck to gate on `HEAD == lock-value` (not literal `main`) when a lock is active
- Adds `lockedBranch` fact wired at boot time via the lock-file reader

## Changes
- `src/apps/dev/src/core/boot.ts` — `precheck` uses `lockedBranch ?? "main"` as the expected branch
- `src/apps/dev/src/runtime/wire.ts` — `collectBootOptions` reads the lock file and surfaces `lockedBranch` in the facts
- `src/apps/dev/tests/boot.test.ts` — three new cases: locked passes on lock-value, fails on main, fails on other-branch
- `src/apps/dev/tests/landing.test.ts` — regression test: locked with non-main lock-branch integrates/merges/pushes the lock branch, never main

## Test plan
- [ ] `pnpm --filter dev test` — all 1141 tests pass (79 files)
- [ ] Locked attempt with `lock-value != main` lands on the lock branch (landing.test.ts regression)
- [ ] Boot precheck with active lock gates on `HEAD == lock-value` (boot.test.ts)

Closes #569

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/603"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783613319&installation_id=129708444&pr_number=603&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F603&signature=35da2197382c5b357897443386b36d54825674a3172cb8c6ebac9957fae047b5"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Projects can now designate a locked branch (instead of always requiring "main") via configuration file for development workflows.

* **Tests**
  * Added test coverage for locked branch validation and integration behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): locked landing targets the resolved base, not main

## Files changed

- `src/apps/dev/src/core/boot.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/boot.test.ts`
- `src/apps/dev/tests/landing.test.ts`

