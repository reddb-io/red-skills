---
title: fix(afk): uncap sandcastle inner agent maxIterations (fixes #322)
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-327]
pr: 327
merge_sha: 3b6e2fdf5f0397f2a09aba39d35509376402b2a9
---

# fix(afk): uncap sandcastle inner agent maxIterations (fixes #322)

- **PR:** [#327](https://github.com/reddb-io/red-skills/pull/327)
- **Author:** @filipeforattini
- **Merge SHA:** `3b6e2fdf5f0397f2a09aba39d35509376402b2a9`
- **Format:** merged pull request

## Summary

CRITICAL. buildRunOptions never set sandcastle's maxIterations -> inherited the default 1 -> agent cut off before emitting DONE -> every issue blocked:crashed, AFK unusable. Set maxIterations=25 (env-tunable RED_AFK_MAX_ITERATIONS). Regression-guard test. 699 tests. Closes #322. Runtime acceptance pending a real run (#284). [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/327"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782856590&installation_id=129708444&pr_number=327&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F327&signature=83eb80aea8a64b40d78b435102428d6edde8ded6281f3753dd4eea7e1d8b13d3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): uncap the sandcastle inner agent (maxIterations) — fixes #322

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/core/execution.ts`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/tests/execution.test.ts`

