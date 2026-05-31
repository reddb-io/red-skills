---
title: refactor(afk): remove dead pre-sandcastle orphan modules
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-297]
pr: 297
merge_sha: 8a053ccd9d5e018861cb72349c4ac84409e155a1
---

# refactor(afk): remove dead pre-sandcastle orphan modules

- **PR:** [#297](https://github.com/reddb-io/red-skills/pull/297)
- **Author:** @filipeforattini
- **Merge SHA:** `8a053ccd9d5e018861cb72349c4ac84409e155a1`
- **Format:** merged pull request

## Summary

Architecture review candidate #3 — the deletion test. Removes core/capabilities.ts (zero importers; sandcastle owns execution mode) and the dead runInner cluster from runner-spawn.ts (kept the 4 live exports run.ts/execution.ts use). tsc clean proves no live importer broke. 700->664 tests (dead tests removed). [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/297"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782791081&installation_id=129708444&pr_number=297&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F297&signature=fbd8ae80bf172b35c86cbf3eb103e343556f69e91d5346120e03b4048cd69848"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(afk): remove dead pre-sandcastle orphan modules

## Files changed

- `src/domains/dev/src/core/capabilities.ts`
- `src/domains/dev/src/core/runner-spawn.ts`
- `src/domains/dev/tests/capabilities.test.ts`
- `src/domains/dev/tests/runner-spawn.test.ts`

