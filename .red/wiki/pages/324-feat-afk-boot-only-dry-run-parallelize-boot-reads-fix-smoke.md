---
title: feat(afk): --boot-only dry-run + parallelize boot reads + fix smoke
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-324]
pr: 324
merge_sha: f2d67bb435499075e254ea56b60ebd3a95e60f23
---

# feat(afk): --boot-only dry-run + parallelize boot reads + fix smoke

- **PR:** [#324](https://github.com/reddb-io/red-skills/pull/324)
- **Author:** @filipeforattini
- **Merge SHA:** `f2d67bb435499075e254ea56b60ebd3a95e60f23`
- **Format:** merged pull request

## Summary

Adds an honest --boot-only mode (boot sweeps then exit, no agent — fills the slot -n 0 wrongly occupied since 0=unlimited-drain). Fixes the smoke's false -n 0 assumption. Parallelizes the boot's independent gh/git reads (conservative Promise.all, parity-preserving). 693 tests. bin/afk.mjs rebuilt. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/324"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782824376&installation_id=129708444&pr_number=324&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F324&signature=f2688dc066b4ea3bd914bdb0288a0d9d78881516c589b50286e7ff9f93e9d33d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): honest --boot-only dry-run + parallelize boot reads; fix s…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `scripts/afk-e2e-smoke.sh`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/session.ts`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/tests/run-flags.test.ts`
- `src/domains/dev/tests/session.test.ts`

