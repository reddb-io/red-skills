---
title: feat(afk-lane): auto-pick skips parked issues (ready-for-human / blocked:*)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-729]
pr: 729
merge_sha: f7b8e582c3e270dcd4aff5be8d1a2b6fd643346b
---

# feat(afk-lane): auto-pick skips parked issues (ready-for-human / blocked:*)

- **PR:** [#729](https://github.com/reddb-io/red-skills/pull/729)
- **Author:** @filipeforattini
- **Merge SHA:** `f7b8e582c3e270dcd4aff5be8d1a2b6fd643346b`
- **Format:** merged pull request

## Summary

## Why

Live finding while testing the dispatch auto-pick (#728): it grabbed the oldest issue carrying `ready-for-agent` even when that issue was **also parked** — `#585` held `ready-for-agent` **and** `ready-for-human` + `blocked:spec` + an active validation blocker. The auto-pick picked it, then the runtime preflight correctly refused (human needed) and the dispatch did no real work.

## What

The auto-pick now filters out PRs **and parked issues** (`ready-for-human` or any `blocked:*` label) and takes the oldest **actionable** `ready-for-agent` issue. It logs how many parked candidates it skipped, and still no-ops cleanly when nothing actionable remains.

Workflow-only (the reusable's resolve step). The runtime preflight stays the authoritative gate (it also reads the `## Current blocker` body block a label filter can't see); this just stops the auto-pick from wasting a dispatch on an obviously-parked issue.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/729"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783824625&installation_id=129708444&pr_number=729&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F729&signature=e34687cf3743db92fed3324a7beea3b1b37158b72779439994d59fe3c7942e1a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **Bug Fixes**
  * Improved issue selection logic to prioritize oldest actionable issues
  * Enhanced handling of blocked and parked issues with detailed skip reporting
  * Cleaner behavior when no actionable issues are available

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk-lane): auto-pick skips parked issues (ready-for-human / bloc…

## Files changed

- `.github/workflows/reusable-afk-attempt.yml`

