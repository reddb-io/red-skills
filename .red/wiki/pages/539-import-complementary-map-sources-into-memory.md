---
title: Import complementary map sources into Memory
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-539]
pr: 539
merge_sha: 44650937f1988c9d9cbfe12c198d2fca01e85b93
---

# Import complementary map sources into Memory

- **PR:** [#539](https://github.com/reddb-io/red-skills/pull/539)
- **Author:** @filipeforattini
- **Merge SHA:** `44650937f1988c9d9cbfe12c198d2fca01e85b93`
- **Format:** merged pull request

## Summary

Closes #528\n\n## Summary\n- add a RedDB-backed complementary map importer exposed as `memory import map`\n- support Graphify-like node/edge JSON with external-map provenance, confidence, freshness, and normalized edge weights\n- test imported metadata, deterministic overlap handling, and RedDB as the destination\n\n## Validation\n- `pnpm --dir src/apps/memory run typecheck`\n- `pnpm --dir src/apps/memory test`

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/539"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783388511&installation_id=129708444&pr_number=539&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F539&signature=f90753b07584e3eba9180cdbee5305cb10d814520da591e543f67ccbc27f9b23"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added a new CLI subcommand for importing complementary maps into graph storage with automatic validation.
  * System now tracks imported maps as external data sources and returns detailed reports including node/edge counts, warnings, and deduplication metrics.
  * Imports are idempotent—re-running the same import does not create duplicates.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add complementary map import path

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/import-complementary-map.ts`
- `src/apps/memory/src/schema.ts`
- `src/apps/memory/tests/fixtures/complementary-map/graphify-map.json`
- `src/apps/memory/tests/import-complementary-map.test.ts`

