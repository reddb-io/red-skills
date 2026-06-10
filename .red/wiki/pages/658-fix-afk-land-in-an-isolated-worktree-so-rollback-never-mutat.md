---
title: fix(afk): land in an isolated worktree so rollback never mutates the primary checkout
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-658]
pr: 658
merge_sha: 174651f072bd8e0a05b008a607e4cb2d0c466273
---

# fix(afk): land in an isolated worktree so rollback never mutates the primary checkout

- **PR:** [#658](https://github.com/reddb-io/red-skills/pull/658)
- **Author:** @filipeforattini
- **Merge SHA:** `174651f072bd8e0a05b008a607e4cb2d0c466273`
- **Format:** merged pull request

## Summary

Closes #572

Moves the landing sequence into a temporary git worktree so that a failed merge/rebase can never leave uncommitted changes in the primary checkout. The rollback is now trivially safe: remove the worktree, primary is untouched.

Validation: tsc clean, build passed, 1179 tests in worker run (full suite). The feedback gate was blocked by the known supervisor.test.ts OOM on the feedback host (issue #460, pre-existing on main — reproducible without this change). Opened manually to bypass the false-positive gate.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/658"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783697556&installation_id=129708444&pr_number=658&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F658&signature=a52782ff3fbf3d278c4e657267d4ffb6685892f1e64b55985722067e7773477f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): land in an isolated worktree so rollback never mutates the …

## Files changed

- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/landing.ts`
- `src/apps/dev/src/core/merge.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/core/reconcile.ts`
- `src/apps/dev/tests/landing.test.ts`
- `src/apps/dev/tests/merge.test.ts`
- `src/apps/dev/tests/process-issue.test.ts`

