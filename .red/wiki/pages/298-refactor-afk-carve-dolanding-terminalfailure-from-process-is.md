---
title: refactor(afk): carve doLanding + terminalFailure from process-issue
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-298]
pr: 298
merge_sha: ffd22fac88736bc189a7a07b4e3af03de255c61a
---

# refactor(afk): carve doLanding + terminalFailure from process-issue

- **PR:** [#298](https://github.com/reddb-io/red-skills/pull/298)
- **Author:** @filipeforattini
- **Merge SHA:** `ffd22fac88736bc189a7a07b4e3af03de255c61a`
- **Format:** merged pull request

## Summary

Architecture review round 2, candidates 1+2. Extracts core/landing.ts (lock-toggled Landing, ADR 0030/0031 — now directly testable) and a terminalFailure() helper from the 1012-LOC process-issue orchestrator; extends attempt-outcome with envelopeStatusFor. Pure behaviour-preserving — all 13 terminal/landing paths identical, oracle tests unchanged. Adds the Landing domain term. 684 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/298"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782792307&installation_id=129708444&pr_number=298&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F298&signature=fc39bfc3e3c50ed1b54faee37de64f84e1d0ec5de23a5ddaf5f8bea765da7b19"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(afk): carve doLanding + terminalFailure from the process-iss…

## Files changed

- `.red/contexts/dev/CONTEXT.md`
- `src/domains/dev/src/core/attempt-outcome.ts`
- `src/domains/dev/src/core/landing.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/tests/attempt-outcome.test.ts`
- `src/domains/dev/tests/landing.test.ts`

