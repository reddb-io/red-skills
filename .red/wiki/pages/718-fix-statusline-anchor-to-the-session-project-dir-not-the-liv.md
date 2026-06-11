---
title: fix(statusline): anchor to the session project_dir, not the live cwd
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-718]
pr: 718
merge_sha: 239efaa206ee312be143e874800421423d812837
---

# fix(statusline): anchor to the session project_dir, not the live cwd

- **PR:** [#718](https://github.com/reddb-io/red-skills/pull/718)
- **Author:** @filipeforattini
- **Merge SHA:** `239efaa206ee312be143e874800421423d812837`
- **Format:** merged pull request

## Summary

## The bug (reported live)
The statusline kept changing the project name as you `cd` into subdirectories — so you lose track of which project you're in. It derived the basename, git ref, AND the AFK worker block (resolved under `<root>/.red/tmp`) from `.workspace.current_dir` (the live cwd), so everything followed you into subdirs and the worker block vanished there.

## Fix
`resolveRoot` now prefers **`.workspace.project_dir`** — the directory the Claude Code session was *started* in, which stays fixed — falling back to `current_dir`/`cwd` for hosts that don't send it. This aligns the code with what the `setup-statusline` skill already documents (it claimed project_dir was used; it wasn't). One-line resolution change + type + a covering test.

## Bonus (a regression CI can't see)
Fixed a `statusline-command` test fixture that omitted a fresh timestamp — its pid-live worker failed the `isStateActive` freshness gate added in v1.200.1 (ADR 0065). The test never went red in CI because **`pnpm test` runs in no workflow** (the #446 OOM blocks adding it). A real worker always stamps `started_at`, so this was a fixture gap, not a product bug — but it's a reminder the test suite isn't gating PRs.

## Validation
- typecheck clean; statusline-command (8) + statusline (29) tests green.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/718"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783807716&installation_id=129708444&pr_number=718&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F718&signature=01c1ec0398173ef68ca23e4d3328a59f92761d8175b18c590877e8d8509669f1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Session project root now resolves to the session's starting directory, remaining stable when navigating subdirectories.

* **Tests**
  * Added comprehensive tests for project root resolution and session activity tracking logic.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(statusline): anchor to the session project_dir, not the live cwd

## Files changed

- `apps/dev/src/commands/statusline.ts`
- `apps/dev/tests/statusline-command.test.ts`

