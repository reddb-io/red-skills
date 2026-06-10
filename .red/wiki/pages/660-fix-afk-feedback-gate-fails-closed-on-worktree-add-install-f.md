---
title: fix(afk): feedback gate fails closed on worktree-add/install failure and validates origin tip
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-660]
pr: 660
merge_sha: a6b09b34137e02d6bbbbb26670beaa536655ab49
---

# fix(afk): feedback gate fails closed on worktree-add/install failure and validates origin tip

- **PR:** [#660](https://github.com/reddb-io/red-skills/pull/660)
- **Author:** @filipeforattini
- **Merge SHA:** `a6b09b34137e02d6bbbbb26670beaa536655ab49`
- **Format:** merged pull request

## Summary

## Summary

Closes #576.

The feedback gate had three silent-pass bugs that could cause the gate to validate the wrong code or skip validation:

- **Worktree-add failure → fallback to primary checkout**: when `git worktree add` failed, the path resolver returned `root` (main) and validated that instead of the branch. Fixed: failures now return `null`, which propagates code 1 through all validation calls.
- **Failed frozen-lockfile install → warn-and-continue**: a non-zero `pnpm install --frozen-lockfile` only warned; the gate continued without binaries (tsc/vite/etc.) causing false validation results. Fixed: install failure removes the partial checkout and blocks.
- **Stale local ref**: validation could run against a local branch ref that diverged from what was pushed. Fixed: `worktreeAdd` always fetches origin first and checks out `origin/<branch>`.

## Acceptance criteria

- [x] A `git worktree add` failure blocks the attempt — never falls back to validating the primary checkout (`feedback-worktree.ts:121–127`)
- [x] A failed frozen-lockfile install blocks rather than warning-and-continuing (`feedback-worktree.ts:133–145`)
- [x] The gate validates the freshly-pushed origin tip, not a stale local ref (`git.ts:167–170`)
- [x] Tests cover worktree-add-fails → block at the feedback-worktree seam (`feedback-worktree.test.ts:132–143`)

## Test plan

- `pnpm test` in `src/apps/dev` — all 10 `feedback-worktree.test.ts` tests pass; 1197 total tests pass
- `pnpm tsc --noEmit` — no type errors

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/660"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783698230&installation_id=129708444&pr_number=660&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F660&signature=8723e4d567db8ad5b05c0ca328dbc8fae81f6fd6c6e19df940845449d4019cfb"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Fixed error handling for git worktree initialization failures—validation now fails cleanly instead of falling back to a secondary checkout path.

* **Tests**
  * Enhanced test coverage to verify proper blocking behavior when worktree setup or dependency installation fails.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): feedback gate fails closed on worktree-add/install failure …
- docs(afk): fix stale comment in feedback-worktree — gate now fails cl…

## Files changed

- `src/apps/dev/src/runtime/feedback-worktree.ts`
- `src/apps/dev/src/runtime/git.ts`
- `src/apps/dev/tests/feedback-worktree.test.ts`

