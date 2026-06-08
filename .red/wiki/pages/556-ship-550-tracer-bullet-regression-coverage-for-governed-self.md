---
title: ship: #550 Tracer-bullet regression coverage for governed self-improvement
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-556]
pr: 556
merge_sha: c56bc371108b195fe64f54c2055bb833221eb0fb
---

# ship: #550 Tracer-bullet regression coverage for governed self-improvement

- **PR:** [#556](https://github.com/reddb-io/red-skills/pull/556)
- **Author:** @filipeforattini
- **Merge SHA:** `c56bc371108b195fe64f54c2055bb833221eb0fb`
- **Format:** merged pull request

## Summary

Interactive /ship landing for #550.

Closes #550

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/556"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783492143&installation_id=129708444&pr_number=556&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F556&signature=a9e3efff90e73dfa04330e4e3a0f316dc9d0af62bf3f586a19731430c1e25a8d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Sensitive values (e.g., tokens) are now redacted in evidence cards to protect secrets.
  * Applying a proposal without explicit approval now fails as expected.

* **New Features**
  * Evidence card approval and rejection workflows available for skill-improvement flows.
  * Evidence cards are reused reliably across repeated skill-improvement runs.
  * Rejected evidence cards show a review-warning section. 

* **Chores**
  * CI workflows updated to install a runtime tool used in memory regression and drift checks.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- test(memory): cover governed self-improvement tracer bullet
- ci: install red binary before workspace install
- ci: harden red binary bootstrap

## Files changed

- `.github/actions/install-red-binary/action.yml`
- `.github/workflows/red-memory-bench.yml`
- `.github/workflows/red-memory-drift-guard.yml`
- `src/apps/memory/src/cli.ts`
- `src/apps/memory/tests/improve-skills.test.ts`

