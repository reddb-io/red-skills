---
title: feat(afk): statusline reads project root from first arg; 🙋→🆘
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-266]
pr: 266
merge_sha: fd9c8fe43eaf03e4923f73e74970952da9cded97
---

# feat(afk): statusline reads project root from first arg; 🙋→🆘

- **PR:** [#266](https://github.com/reddb-io/red-skills/pull/266)
- **Author:** @filipeforattini
- **Merge SHA:** `fd9c8fe43eaf03e4923f73e74970952da9cded97`
- **Format:** merged pull request

## Summary

## What
- **First-arg root.** `statusline.sh` now takes the project root as `$1` (falling back to the stdin payload / `$PWD`). Wire it as `statusline.sh "$CLAUDE_PROJECT_DIR"` so the statusline always reads the checkout Claude Code was started in, not wherever the command runs. Backward-compatible: a blank/non-dir arg uses the old resolution.
- **Emoji.** ready-for-human `🙋` → `🆘` (clearer 'needs a human').
- **Tests.** `statusline.test.sh` was stale (asserted an old verbose `blocked N / ready N / human N` render and an empty-when-no-workers contract the script dropped once it began always emitting the project-name block). Re-synced to the compact-emoji render and added first-arg + blank-arg coverage. **25 assertions pass.**
- **Docs.** statusline SKILL documents the `"$CLAUDE_PROJECT_DIR"` form and warns against pinning a `cache/<version>` path.

## Why
A user's `.claude/settings.json` had pinned `…/cache/red-skills/dev/1.87.0/…/statusline.sh` (53 versions stale). The documented `${CLAUDE_PLUGIN_ROOT}` form always runs the newest installed version; passing the project root explicitly makes worker discovery robust.

## Validation
`bash …/tests/statusline.test.sh` → 25 assertions passed; `bash -n` clean.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/266"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782713865&installation_id=129708444&pr_number=266&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F266&signature=52fc27147d834ffb4a2938095e3fbfb87bce719da747bb138ff65353fb7ba97e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): statusline reads project root from first arg; 🙋→🆘

## Files changed

- `plugins/dev/skills/engineering/afk/scripts/statusline.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/statusline.test.sh`
- `plugins/dev/skills/engineering/statusline/SKILL.md`

