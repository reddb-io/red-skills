---
title: Extract cross-file TypeScript map edges
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-534]
pr: 534
merge_sha: 86ec70a3c2f10896f86351288f22ade43a57c7a0
---

# Extract cross-file TypeScript map edges

- **PR:** [#534](https://github.com/reddb-io/red-skills/pull/534)
- **Author:** @filipeforattini
- **Merge SHA:** `86ec70a3c2f10896f86351288f22ade43a57c7a0`
- **Format:** merged pull request

## Summary

Follow-up to #522 / #529.\n\nAdds compiler-resolved cross-file TypeScript symbol targets so imported function calls and imported type references can be written as Memory map edges without graph UI/layout metadata.\n\nValidation:\n- pnpm --dir src/apps/memory exec vitest run tests/extract-code.test.ts\n- pnpm --dir src/apps/memory exec vitest run tests/ingest.test.ts\n- pnpm --dir src/apps/memory run typecheck\n- git diff --check

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/534"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783383335&installation_id=129708444&pr_number=534&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F534&signature=0b8043c44e4729a899601dd2cf8a279d2333e297b0d5e029787e40a91990f639"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Improved code analysis: richer, cross-file symbol graph that records calls and type-usage relationships and standardizes symbol labeling, including handling of externally declared symbols.

* **Tests**
  * Added and updated tests to validate compiler-resolved cross-file symbol relationships and adjusted fixtures to exercise the new behavior.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Extract cross-file TypeScript map edges
- Tighten TypeScript map extraction tests

## Files changed

- `src/apps/memory/src/extract-code.ts`
- `src/apps/memory/tests/extract-code.test.ts`
- `src/apps/memory/tests/fixtures/imports/src/app.ts`
- `src/apps/memory/tests/fixtures/imports/src/local.ts`
- `src/apps/memory/tests/ingest.test.ts`

