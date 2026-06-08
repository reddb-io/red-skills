---
title: Resolve #363 lane-idle reaper
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-508]
pr: 508
merge_sha: da60c8e8f26343ca5b7ff69a0d0450e9d0680813
---

# Resolve #363 lane-idle reaper

- **PR:** [#508](https://github.com/reddb-io/red-skills/pull/508)
- **Author:** @filipeforattini
- **Merge SHA:** `da60c8e8f26343ca5b7ff69a0d0450e9d0680813`
- **Format:** merged pull request

## Summary

Ports the validated lane-idle stall reaper work for the solo run path onto current main.\n\nCloses #363\n\nValidation:\n- git diff --check origin/main..HEAD\n- pnpm -C src/apps/dev test -- execution lane-idle-reaper\n- pnpm -C src/apps/dev typecheck

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/508"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783289960&installation_id=129708444&pr_number=508&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F508&signature=9184a66472944650301f828155767e6d0fa02b106d04b6902dc4eda14872f200"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): port the lane-idle stall reaper to the solo run worker (#363)

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/lane-idle-reaper.ts`
- `src/apps/dev/src/runtime/wire.ts`
- `src/apps/dev/tests/execution.test.ts`
- `src/apps/dev/tests/lane-idle-reaper.test.ts`

