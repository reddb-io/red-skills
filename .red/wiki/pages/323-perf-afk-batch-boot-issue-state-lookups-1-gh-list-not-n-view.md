---
title: perf(afk): batch boot issue-state lookups (1 gh list, not N views)
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-323]
pr: 323
merge_sha: 4ef531d3c2279c2775bdff3c242269a7c8b2c67a
---

# perf(afk): batch boot issue-state lookups (1 gh list, not N views)

- **PR:** [#323](https://github.com/reddb-io/red-skills/pull/323)
- **Author:** @filipeforattini
- **Merge SHA:** `4ef531d3c2279c2775bdff3c242269a7c8b2c67a`
- **Format:** merged pull request

## Summary

The boot's three sweeps each did a sequential gh issue view per issue (~3K+CxB round-trips, >2min). Replace with one batched gh issue list -> map; all lookups read the map with a live fallback on miss. Pure sweep modules unchanged; behaviour-preserving (oracle tests green). 691 tests. bin/afk.mjs rebuilt. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/323"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782823009&installation_id=129708444&pr_number=323&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F323&signature=40f1d4e067a8c62c9a49c92e2aaa8449131eff8031d1185f3445a802401e6bbb"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- perf(afk): batch the boot issue-state lookups — 1 gh list, not N gh v…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/runtime/gh.ts`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/tests/gh-batch.test.ts`

