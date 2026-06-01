---
title: fix(afk): restore Task Mirror via monitor --mirror-plan
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-331]
pr: 331
merge_sha: 4f1d396b3c4c50c3563cd8cbedc3df6afa841e00
---

# fix(afk): restore Task Mirror via monitor --mirror-plan

- **PR:** [#331](https://github.com/reddb-io/red-skills/pull/331)
- **Author:** @filipeforattini
- **Merge SHA:** `4f1d396b3c4c50c3563cd8cbedc3df6afa841e00`
- **Format:** merged pull request

## Summary

The binding Task Mirror was dead (SKILL.md sourced a deleted mirror.sh). Expose the orphaned core/mirror.ts via a monitor --mirror-plan subcommand and repoint SKILL.md to it. 0 dead refs. 765 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/331"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782864874&installation_id=129708444&pr_number=331&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F331&signature=7bc0c336a09b19761e8e81681bd9343d9000060f362ad06cf72aaf4e589402aa"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): restore the Task Mirror — expose monitor --mirror-plan, rep…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/monitor.ts`
- `src/domains/dev/tests/monitor.test.ts`

