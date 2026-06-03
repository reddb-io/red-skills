---
title: test(afk): backpressure gate covers the salvaged no-sentinel path (#432)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-439]
pr: 439
merge_sha: 41dd8af79910b635aa1ebd4b9ce0e165b5ebbe67
---

# test(afk): backpressure gate covers the salvaged no-sentinel path (#432)

- **PR:** [#439](https://github.com/reddb-io/red-skills/pull/439)
- **Author:** @filipeforattini
- **Merge SHA:** `41dd8af79910b635aa1ebd4b9ce0e165b5ebbe67`
- **Format:** merged pull request

## Summary

Closes #432. PRD #429.

#430 placed the `afk.backpressure` gate in the **shared DONE/salvage tail** of `process-issue` (after the feedback gate, before landing). So a salvaged no-sentinel attempt already runs operator backpressure **exactly like a DONE attempt**, satisfying ADR 0047's 'salvage is held to the same bar as DONE'. This adds regression tests:

- salvaged + feedback green + backpressure **fails** → `feedback-failed`, parked to `ready-for-human`+`blocked:validation`, never merged, not an `on_attempt_error`; sidecar carries the `backpressure:<cmd>` failure.
- salvaged + both gates green → lands + closes like DONE.

No production change needed. `process-issue.test.ts` 56/56.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/439"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783086451&installation_id=129708444&pr_number=439&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F439&signature=585896c0ca92bd0ef11fe1e020ac6c75f5f4dbf2fe69f8b9575f5c4fb574dcf3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Tests**
  * Added comprehensive test coverage for issue processing with operator backpressure configuration, validating correct behavior in both failure and success scenarios to ensure reliable handling.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- test(afk): backpressure gate covers the salvaged no-sentinel path (#432)

## Files changed

- `src/apps/dev/tests/process-issue.test.ts`

