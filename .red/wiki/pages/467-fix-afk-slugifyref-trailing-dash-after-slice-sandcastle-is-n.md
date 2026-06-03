---
title: fix(afk): slugifyRef trailing dash after slice → sandcastle 'is not a working tree' (#442)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-467]
pr: 467
merge_sha: a7fc337803343249983afe18b8dea8a02e4e2ae2
---

# fix(afk): slugifyRef trailing dash after slice → sandcastle 'is not a working tree' (#442)

- **PR:** [#467](https://github.com/reddb-io/red-skills/pull/467)
- **Author:** @filipeforattini
- **Merge SHA:** `a7fc337803343249983afe18b8dea8a02e4e2ae2`
- **Format:** merged pull request

## Summary

Closes #442.

`slugifyRef` trimmed leading/trailing dashes and **then** `.slice(0, 40)`, so a slice landing mid-word **re-introduced a trailing dash** — e.g. #301's title `Memory soft-merge edge: hide a duplicate node…` → `memory-soft-merge-edge-hide-a-duplicate-`. That trailing-dash slug fed the branch ref **and** the sandcastle worktree name (`afk-wSG0G-301-…-duplicate-`), which got normalised inconsistently downstream → `fatal: … is not a working tree`, crashing worker wSG0G mid-attempt (observed while babysitting).

**Fix:** re-trim trailing dashes after the slice (one `.replace(/-+$/g, "")`). Regression test uses the exact #301 title. `remote-branch.test.ts` 16/16; typecheck clean.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/467"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783108129&installation_id=129708444&pr_number=467&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F467&signature=5bfb51fb73e9f7c85774b82bb71a25dcb518431d066deda25aaeefcb38311610"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): slugifyRef never emits a trailing dash → no malformed workt…

## Files changed

- `src/apps/dev/src/core/remote-branch.ts`
- `src/apps/dev/tests/remote-branch.test.ts`

