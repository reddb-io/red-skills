---
title: fix(afk): pnpm install the feedback worktree before validating (#458)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-459]
pr: 459
merge_sha: 91d402ed9c4d7876ffe59f983702925f3d51f7f3
---

# fix(afk): pnpm install the feedback worktree before validating (#458)

- **PR:** [#459](https://github.com/reddb-io/red-skills/pull/459)
- **Author:** @filipeforattini
- **Merge SHA:** `91d402ed9c4d7876ffe59f983702925f3d51f7f3`
- **Format:** merged pull request

## Summary

## Summary

Fixes #458 — the AFK feedback validation gate was running `pnpm -r test/build` in a freshly `git worktree add`-ed checkout (`.red/tmp/feedback/<slug>`) that had **no `node_modules`**, so every check failed with `tsc/vite/svelte-kit: not found`. That false validation failure parked otherwise-green DONE work as `blocked:validation` (observed on red-ui#73).

## Change

- `makeFeedbackWorktree` now runs `pnpm install --frozen-lockfile` in the materialised checkout **immediately after `worktreeAdd`, before any check runs**.
- On install failure it keeps the checkout (validation reflects the branch's real state rather than silently validating `main`) and logs a `warn:` line.
- The manager's real-process surface is now injectable (`FeedbackWorktreeIO` = `worktreeAdd`/`worktreeRemove`/`pnpm`/`exec`) so the materialise→install ordering is unit-testable with **zero subprocesses**.

## Tests

- 3 new regression tests in `feedback-worktree.test.ts`: `add → install → script` ordering, single-install on branch reuse, and the install-failure-keeps-checkout path.
- `feedback-worktree` / `feedback` / `wiring-integration` suites: **25/25 green**. `tsc --noEmit` clean.

## Note (out of scope)

The full dev suite exits 0 but reports one `tinypool` "Worker exited unexpectedly" unhandled error during **pool teardown** (after the last test). This reproduces identically on clean `main` (`880/911` there vs `883/914` here — the +3 is exactly these new tests) and is **pre-existing and unrelated** to this change. Filed separately.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/459"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783096875&installation_id=129708444&pr_number=459&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F459&signature=e6b88b12a7bab289296c4827f7cf12c0ed58a7fa47ff194dc70b118805fef91f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Worktree setup now automatically installs dependencies with `pnpm install --frozen-lockfile` when materializing new checkouts.

* **Bug Fixes**
  * Installation failures now emit warnings and preserve checkout state instead of rolling back completely.

* **Tests**
  * Added test coverage for worktree materialization and dependency installation workflows.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): pnpm install the feedback worktree before validating (#458)

## Files changed

- `src/apps/dev/src/runtime/feedback-worktree.ts`
- `src/apps/dev/tests/feedback-worktree.test.ts`

