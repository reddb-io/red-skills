---
title: chore(legacy): remove dead exports and orphan build path
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-669]
pr: 669
merge_sha: cf51c52a8abd5d2f2dd7409b582a167787736081
---

# chore(legacy): remove dead exports and orphan build path

- **PR:** [#669](https://github.com/reddb-io/red-skills/pull/669)
- **Author:** @filipeforattini
- **Merge SHA:** `cf51c52a8abd5d2f2dd7409b582a167787736081`
- **Format:** merged pull request

## Summary

## Summary

- Drop `SYNTHETIC_TYPES` from `jsonl-log.ts` — exported but never imported anywhere
- Drop `AfkCurrent` type from `state.ts` — exported but never imported anywhere  
- Remove `compile` script and `tsconfig.build.json` from dev app — build goes through esbuild bundles, not tsc emit; the compile script was never called by `build`, CI, or any other script

## Acceptance criteria
- [x] `SYNTHETIC_TYPES` and `AfkCurrent` confirmed unreferenced and removed
- [x] Orphan `compile` script + `tsconfig.build.json` removed (rationale: build path is esbuild, not tsc emit)
- [x] Typecheck passes; 83/84 test files pass (1 known OOM in supervisor.test.ts, pre-existing on main)

Closes #598

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/669"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783723780&installation_id=129708444&pr_number=669&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F669&signature=584b6444a68d83a1c5d1567122b450b5175133ffd21a3ece9281c3b4b03ffb49"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Chores**
  * Removed build script and related TypeScript configuration from the development environment
  * Cleaned up internal module exports by removing unused type aliases and constants
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(legacy): remove dead exports and orphan build path

## Files changed

- `src/apps/dev/package.json`
- `src/apps/dev/src/core/jsonl-log.ts`
- `src/apps/dev/src/types/state.ts`
- `src/apps/dev/tsconfig.build.json`

