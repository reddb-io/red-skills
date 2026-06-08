---
title: Add tidy recommendation review workflow
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-498]
pr: 498
merge_sha: 58be9f3af1ab867e0807361ccb6b3c9cdb49bb16
---

# Add tidy recommendation review workflow

- **PR:** [#498](https://github.com/reddb-io/red-skills/pull/498)
- **Author:** @filipeforattini
- **Merge SHA:** `58be9f3af1ab867e0807361ccb6b3c9cdb49bb16`
- **Format:** merged pull request

## Summary

Closes #490.

## Summary
- Add explicit `memory tidy-review refresh|accept|dismiss` commands for provider tidy recommendations.
- Record accept/dismiss review metadata while keeping governance/reporting read-only.
- Validate stale/non-open recommendations and preserve reviewed status in governance output.

## Validation
- `pnpm --dir src/apps/memory typecheck`
- `pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/governance-tidy-review.test.ts`
- `pnpm --dir src/apps/memory exec vitest run tests/suite-split.test.ts`
- Default memory suite: 76 files / 776 tests passed during validation.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/498"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783254232&installation_id=129708444&pr_number=498&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F498&signature=0159b0a787eedb954777341836efcc962ffb29d63b277221ebeaf05c2c409a3c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Added `memory tidy-review` command with `refresh`, `accept`, and `dismiss` subcommands for managing governance recommendations.
  * Enhanced recommendation artifacts to record reviewer actions and approval metadata.

* **Tests**
  * Added integration tests for tidy-review command workflows.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add tidy recommendation review workflow

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/governance-tidy-review.ts`
- `src/apps/memory/src/governance-tidy.ts`
- `src/apps/memory/src/provider-review-artifacts.ts`
- `src/apps/memory/tests/governance-tidy-review.test.ts`
- `src/apps/memory/vitest.suites.ts`

