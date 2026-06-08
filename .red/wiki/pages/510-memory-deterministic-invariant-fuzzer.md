---
title: Memory: deterministic invariant fuzzer
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-510]
pr: 510
merge_sha: 5996b73b6ede853bfbfac9ab5e53859874f046d9
---

# Memory: deterministic invariant fuzzer

- **PR:** [#510](https://github.com/reddb-io/red-skills/pull/510)
- **Author:** @filipeforattini
- **Merge SHA:** `5996b73b6ede853bfbfac9ab5e53859874f046d9`
- **Format:** merged pull request

## Summary

## Summary
- add a seedable VOPR-lite invariant fuzzer for Memory graph supersession, soft merge/unmerge, inferred structural typing, and code drift curation paths
- fix re-added soft-merge edges by clearing logical removal tombstones on fresh edge inserts
- add a focused regression for remove/re-add soft merges hiding duplicates again

## Validation
- pnpm --dir src/apps/memory typecheck
- pnpm --dir src/apps/memory exec vitest run tests/invariant-fuzzer.test.ts
- pnpm --dir src/apps/memory exec vitest run tests/graph-store.test.ts -t "soft merge"
- pnpm --dir src/apps/memory test

Closes #311

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/510"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783296412&installation_id=129708444&pr_number=510&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F510&signature=fdbe0b5cd5aeb941418dbf6522c5f2e52e521b4202fcc7508544c8da6c413b3e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **Bug Fixes**
  * Fixed issue where re-inserted edges would incorrectly remain hidden due to prior deletion records.

* **Tests**
  * Added test coverage for edge merging and unmerging behavior.
  * Added invariant fuzzer tests to validate memory consistency across randomized operations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add memory invariant fuzzer

## Files changed

- `src/apps/memory/src/graph-store.ts`
- `src/apps/memory/tests/graph-store.test.ts`
- `src/apps/memory/tests/invariant-fuzzer.test.ts`

