---
title: fix(afk): feedback gate resolves multi-slash afk/* branches (#437)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-438]
pr: 438
merge_sha: 87e4da978416af0b74c2cef2cd160d9cc7af1768
---

# fix(afk): feedback gate resolves multi-slash afk/* branches (#437)

- **PR:** [#438](https://github.com/reddb-io/red-skills/pull/438)
- **Author:** @filipeforattini
- **Merge SHA:** `87e4da978416af0b74c2cef2cd160d9cc7af1768`
- **Format:** merged pull request

## Summary

Closes #437.

The feedback worktree seam (`feedback-worktree.ts`) split its `-C <branch>/<scope>` token at the **first** slash, but AFK worker branches are `afk/<id>/<N>-<slug>` (two slashes). So `afk/wY7AL/430-slug` parsed as branch=`afk` → `worktreeAdd` fails → root fallback → `pnpm -C <root>/wY7AL/430-slug` → `ENOENT lstat .../red-skills/wY7AL`. **Every afk/* branch failed the feedback gate**, parking correct work to `blocked:validation` and blocking autonomous merge (observed live on #430/#431).

Fix: `splitBranchDir` now peels the scope as the trailing path suffix that is a real package dir (via the existing `layout` probe), leaving the full branch as the prefix. Promoted to an exported pure fn with a focused unit test. Typecheck clean; feedback-worktree (6) + wiring-integration (2) green.

This is the third AFK-reliability fix this session (sibling of #434 launcher/claim-race and #430 backpressure) and a release-blocker for autonomous merge in the post-reload "definitive AFK."

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/438"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783086099&installation_id=129708444&pr_number=438&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F438&signature=89e67150304e8527c7aad0853fca4ac3c46b0718fa1465c3ad7a4e2fd1353de1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved branch directory parsing to accurately handle paths containing multiple slashes, resolving checkout issues in monorepo environments.

* **Tests**
  * Added test coverage for branch and scope extraction logic, including edge cases with nested packages and complex paths.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): feedback gate resolves multi-slash afk/* branches (#437)

## Files changed

- `src/apps/dev/src/runtime/feedback-worktree.ts`
- `src/apps/dev/tests/feedback-worktree.test.ts`

