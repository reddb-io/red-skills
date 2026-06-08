---
title: Provider review artifacts persist tidy state outside the graph
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-493]
pr: 493
merge_sha: ee9fdc192e87674bdf5b5c58da833f0691ff66f6
---

# Provider review artifacts persist tidy state outside the graph

- **PR:** [#493](https://github.com/reddb-io/red-skills/pull/493)
- **Author:** @filipeforattini
- **Merge SHA:** `ee9fdc192e87674bdf5b5c58da833f0691ff66f6`
- **Format:** merged pull request

## Summary

Closes #486.

## Summary
- add provider review artifact persistence backed by Memory KV storage outside graph nodes/edges
- add deterministic fingerprints and stable recommendation/artifact ids
- cover stale transitions, status persistence, and graph/recall non-mutation

## Validation
- pnpm exec vitest run tests/provider-review-artifacts.test.ts
- pnpm exec tsc -p tsconfig.json --noEmit

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/493"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783250022&installation_id=129708444&pr_number=493&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F493&signature=159b36a333cdee8f855185bee9ecb6925fe8b0a734ab79abea8542ec2b996c95"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Introduced provider review artifact management system with deterministic fingerprinting and persistence capabilities. Supports tracking review statuses (open, dismissed, accepted, stale) and provides querying and status update functionality.

* **Tests**
  * Added comprehensive test suite validating fingerprint determinism, artifact persistence, status transitions, and memory store integration.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add provider review artifact persistence

## Files changed

- `src/apps/memory/src/provider-review-artifacts.ts`
- `src/apps/memory/tests/provider-review-artifacts.test.ts`

