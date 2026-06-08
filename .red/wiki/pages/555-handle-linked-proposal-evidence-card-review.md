---
title: Handle linked proposal evidence card review
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-555]
pr: 555
merge_sha: 7765a127e03ac7826ab12853bf3551afe59da530
---

# Handle linked proposal evidence card review

- **PR:** [#555](https://github.com/reddb-io/red-skills/pull/555)
- **Author:** @filipeforattini
- **Merge SHA:** `7765a127e03ac7826ab12853bf3551afe59da530`
- **Format:** merged pull request

## Summary

Closes #549.

## Summary
- keep linked Evidence card approval scoped to card review metadata
- append an Evidence Card Review Warning to linked proposals on card rejection
- preserve proposal apply/archive/delete behavior behind explicit proposal gates

## Validation
- `pnpm --dir src/apps/memory typecheck`
- `pnpm --dir src/apps/memory test:integration evidence-card.test.ts`

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/555"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783489613&installation_id=129708444&pr_number=555&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F555&signature=466844e51c636187a7f68bfdf0215a46ca0f2a0dc0c62b8d20a5765f71129796"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * CLI commands for approving/rejecting evidence now support linked evidence cards, report linked card and proposal paths, accept an optional reviewer, and print linked-result summaries
  * Reject now accepts a reason, applies sensitive-redaction to notes, is idempotent for already-approved/rejected cards, and appends a review warning to linked proposals

* **Tests**
  * Tests updated to cover linked proposal workflows, approval no-ops, rejection warning injection, and related apply/check behavior
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Handle linked proposal evidence card review
- Address linked evidence review feedback
- Preserve linked evidence rejection notes

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/tests/evidence-card.test.ts`

