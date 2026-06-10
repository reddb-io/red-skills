---
title: fix(afk): reconcile salvage fetches origin-only branch before the commits gate
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-611]
pr: 611
merge_sha: 8e5c6bb752780e84b7c6e80d82c258d38a9b78ba
---

# fix(afk): reconcile salvage fetches origin-only branch before the commits gate

- **PR:** [#611](https://github.com/reddb-io/red-skills/pull/611)
- **Author:** @filipeforattini
- **Merge SHA:** `8e5c6bb752780e84b7c6e80d82c258d38a9b78ba`
- **Format:** merged pull request

## Summary

## Summary

- Moves the `branchPresent()` fetch gate before `changedFiles()` in `reconcile.ts` so a branch that exists only on origin (force-pushed by a now-dead worker) is materialized locally before the three-dot diff
- Previously, `changedFiles()` silently returned `[]` for the missing local ref, causing reconcile to return `skipped:no-commits` and no-op on the most common salvage case
- Adds a test covering the origin-only-branch path at the reconcile seam

Closes #571. Parent: #567.

## Test plan

- [ ] New test: `fetches an origin-only branch before the commits gate so it is not skipped as no-commits` — verifies `branchPresent` is called before `changedFiles`, simulating origin-only fetch behavior
- [ ] All 1138 tests pass (`pnpm test --run`)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/611"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783635959&installation_id=129708444&pr_number=611&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F611&signature=1cb09ec61e949865eb311ba779e35a1748bd5122c4581ef9720c385c0f97ba44"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Fixed incorrect status classification where branches present on the host but missing locally could be misreported as "skipped: no-commits"; such cases are now detected earlier and reported as "skipped: branch-absent" so valid changes are not ignored.

* **Tests**
  * Added a test that verifies branch-presence is checked before commit checks to prevent false skips and ensure correct landing behavior.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): reconcile fetches origin-only branch before the commits gate

## Files changed

- `src/apps/dev/src/core/reconcile.ts`
- `src/apps/dev/tests/reconcile.test.ts`

