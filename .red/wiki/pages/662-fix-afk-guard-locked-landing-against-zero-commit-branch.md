---
title: fix(afk): guard locked landing against zero-commit branch
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-662]
pr: 662
merge_sha: d651ed8f5c4a358b55cad1e4de3f862b0f7ee271
---

# fix(afk): guard locked landing against zero-commit branch

- **PR:** [#662](https://github.com/reddb-io/red-skills/pull/662)
- **Author:** @filipeforattini
- **Merge SHA:** `d651ed8f5c4a358b55cad1e4de3f862b0f7ee271`
- **Format:** merged pull request

## Summary

Closes #573

On the locked landing path, `git merge --no-ff` succeeds silently on a branch with no commits relative to the base (it creates a no-op merge commit), causing the issue to be incorrectly marked done. The unlocked path rejects this naturally (`gh pr create` fails on an empty branch). This ports that guard into `landLockedInWorktree`: count commits via `git rev-list --count origin/<base>..origin/<branch>` before calling `landMerge`; return `land-failed` if the count is zero.

Ported from `afk/w9HNK/573-fix-afk-a-zero-commit-branch-never-lands` onto current main (which had `landLockedInWorktree` restructured by #572). The original worker branch has a merge conflict with #572; this is a clean forward-port.

Validation: tsc clean, all 17 landing tests pass.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/662"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783699190&installation_id=129708444&pr_number=662&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F662&signature=9373918897dff90aa27613e844e520807f43490720c3d799da1215a5a638fb82"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): guard locked landing against zero-commit branch (#573)

## Files changed

- `src/apps/dev/src/core/landing.ts`
- `src/apps/dev/tests/landing.test.ts`
- `src/apps/dev/tests/process-issue.test.ts`

