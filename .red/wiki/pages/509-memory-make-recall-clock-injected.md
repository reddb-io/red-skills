---
title: Memory: make recall clock-injected
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-509]
pr: 509
merge_sha: b22f3266f8fcc959feb9e31e366d966b8504816a
---

# Memory: make recall clock-injected

- **PR:** [#509](https://github.com/reddb-io/red-skills/pull/509)
- **Author:** @filipeforattini
- **Merge SHA:** `b22f3266f8fcc959feb9e31e366d966b8504816a`
- **Format:** merged pull request

## Summary

## Summary
- Thread caller-provided `now` through recall node listing, confidence context setup, ASK recall, and access bookkeeping.
- Make `MemoryStore.recordAccess` accept the injected recall timestamp instead of reading `Date.now()` internally.
- Add a ranking regression test that proves AS-OF node visibility and access timestamps use the injected clock.

## Validation
- `pnpm --dir src/apps/memory exec vitest run tests/engine-ranking.test.ts`
- `pnpm --dir src/apps/memory typecheck`
- `pnpm --dir src/apps/memory test`

Refs #312

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/509"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783294974&installation_id=129708444&pr_number=509&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F509&signature=fe0306390917171ced26e94fc5a2aeabd79bab3ab4b390284bc0a0c626a730ea"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Refactor**
  * Enhanced memory recall engine to support deterministic timestamp handling for consistent recency and confidence calculations across memory operations.
  * Updated test coverage to verify time-based memory visibility and access tracking behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Make memory recall clock-injected

## Files changed

- `src/apps/memory/src/engine.ts`
- `src/apps/memory/src/graph-store.ts`
- `src/apps/memory/tests/engine-ranking.test.ts`

