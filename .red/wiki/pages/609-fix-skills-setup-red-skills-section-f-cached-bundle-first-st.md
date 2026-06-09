---
title: fix(skills): setup-red-skills Section F cached-bundle-first statusline (#591)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-609]
pr: 609
merge_sha: 0eb93788f90b903fabd6e5f491a0c38db2db09a2
---

# fix(skills): setup-red-skills Section F cached-bundle-first statusline (#591)

- **PR:** [#609](https://github.com/reddb-io/red-skills/pull/609)
- **Author:** @filipeforattini
- **Merge SHA:** `0eb93788f90b903fabd6e5f491a0c38db2db09a2`
- **Format:** merged pull request

## Summary

Closes #591. Landed via the PRD #567 parallel-landing workflow — a worktree-isolated agent implemented + tested the slice and ran the dev gate green (typecheck + the dev vitest suite) before pushing. Part of PRD #567.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/609"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783624443&installation_id=129708444&pr_number=609&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F609&signature=15a54398d6b758d4f57de7b7b3c07bbf9742bb0e1ee054cbc6e710bfbcdc0444"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated setup instructions for statusline configuration to reflect cached-bundle-first resolution with fallback support
  * Removed outdated documentation about legacy statusline behavior
  * Clarified bundle version selection process in setup guidance

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(skills): setup-red-skills Section F writes cached-bundle-first st…
- Merge remote-tracking branch 'origin/main' into fix/afk-591

## Files changed

- `CHANGES.md`
- `plugins/dev/skills/engineering/doctor/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`

