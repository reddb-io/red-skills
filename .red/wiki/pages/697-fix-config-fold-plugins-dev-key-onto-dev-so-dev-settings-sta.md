---
title: fix(config): fold plugins.dev.<key> onto dev.* so dev settings stay namespaced (extends ADR 0042)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-697]
pr: 697
merge_sha: 79db39f9a3704158bc826f4bd35b0501c9b19bae
---

# fix(config): fold plugins.dev.<key> onto dev.* so dev settings stay namespaced (extends ADR 0042)

- **PR:** [#697](https://github.com/reddb-io/red-skills/pull/697)
- **Author:** @filipeforattini
- **Merge SHA:** `79db39f9a3704158bc826f4bd35b0501c9b19bae`
- **Format:** merged pull request

## Summary

Fixes the inconsistency you spotted: `lock-primary-branch` was stuck at top-level `dev:` instead of nesting under `plugins.dev` like the rest.

**Root cause:** the ADR 0042 fold stripped `plugins.dev.` whole — `plugins.dev.afk.*` → `afk.*` worked, but `plugins.dev.lock-primary-branch` → bare `lock-primary-branch`, a key the loader never reads (it reads `dev.lock-primary-branch`). Namespacing it silently flipped the branch guard off.

**Fix:** the dev plugin's AFK subtree keeps the bare `afk.*` accessor (historical, shared with the legacy `afk:` block); every other `plugins.dev.<key>` now folds onto `dev.<key>`. So `plugins.dev.lock-primary-branch` → `dev.lock-primary-branch`.

- `config.ts` — afk-vs-dev accessor split in the fold.
- `config.test.ts` — namespaced `plugins.dev.lock-primary-branch` resolves; mixed dev+afk under one `plugins.dev` block both land. **45/45**, typecheck clean.
- `.red/config.yaml` — `lock-primary-branch` moved under `plugins.dev`; the repo config is now **fully namespaced (root sacred)**.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/697"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783773501&installation_id=129708444&pr_number=697&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F697&signature=8679de476870e6f50c22d17810b37e0f3c9bbb27313e7da9777a6cc56c40c21c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Updated plugin configuration structure and validation for improved organization.
  * Enhanced configuration key mapping tests to ensure correct behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(config): fold `plugins.dev.<key>` onto the `dev.*` accessor (not …

## Files changed

- `.red/config.yaml`
- `apps/dev/src/core/config.ts`
- `apps/dev/tests/config.test.ts`

