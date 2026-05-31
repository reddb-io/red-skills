---
title: refactor(afk): single-owner Attempt Outcome module
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-295]
pr: 295
merge_sha: 29bde17c9d7ed7e6a2cae83acb0afa3f2d6d2d11
---

# refactor(afk): single-owner Attempt Outcome module

- **PR:** [#295](https://github.com/reddb-io/red-skills/pull/295)
- **Author:** @filipeforattini
- **Merge SHA:** `29bde17c9d7ed7e6a2cae83acb0afa3f2d6d2d11`
- **Format:** merged pull request

## Summary

Collapses the 3 parallel outcome enums (ProcessOutcome/BlockedReason/RecoveryReason) + the recoveryReasonOf bridge into one owner, core/attempt-outcome.ts. Pure behaviour-preserving refactor — same labels/routing/caps, existing tests pass unchanged; new exhaustive table makes desync impossible. 698 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/295"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782789821&installation_id=129708444&pr_number=295&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F295&signature=c2ad09a9c2af427b72f675b94e23a4540a856fe729d57bf42768fc1ec5ce3e95"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(afk): single-owner Attempt Outcome module (collapse 3 enums)

## Files changed

- `src/domains/dev/src/core/attempt-outcome.ts`
- `src/domains/dev/src/core/envelope-emit.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/core/recovery.ts`
- `src/domains/dev/src/core/supervisor.ts`
- `src/domains/dev/tests/attempt-outcome.test.ts`
- `src/domains/dev/tests/envelope-emit.test.ts`
- `src/domains/dev/tests/recovery.test.ts`

