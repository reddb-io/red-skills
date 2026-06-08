---
title: chore: bump mattpocock skills upstream pin
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-511]
pr: 511
merge_sha: fb67914161836cf1570e580013f3d33a987de6bf
---

# chore: bump mattpocock skills upstream pin

- **PR:** [#511](https://github.com/reddb-io/red-skills/pull/511)
- **Author:** @filipeforattini
- **Merge SHA:** `fb67914161836cf1570e580013f3d33a987de6bf`
- **Format:** merged pull request

## Summary

## Summary\n\n- Bump `.upstream` to `mattpocock/skills@aaf2453fbdfe7a15c07f11d861224f34ab4b53cb`.\n- Cherry-pick the relevant upstream `to-prd` testing-seam wording while preserving RedSkills PRD/HITL rules.\n- Record the upstream drift review in `CHANGES.md`.\n\nThe upstream `in-progress/teach` doc tweak was reviewed but not imported because RedSkills does not carry that draft skill.\n\n## Validation\n\n- `git diff --check origin/main..HEAD`\n\nCloses #325

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/511"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783297284&installation_id=129708444&pr_number=511&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F511&signature=0c63b2e6fe32b0f337c19e451434a1000c48319e3c4055b93ab3c6efd9185db1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated engineering skill instructions to prioritize testing seams earlier in PRD planning workflows
  * Enhanced guidance for capturing human decisions during seam selection in PRD planning
  * Updated changelog with latest upstream commit information

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore: bump mattpocock skills upstream pin

## Files changed

- `.upstream`
- `CHANGES.md`
- `plugins/dev/skills/engineering/to-prd/SKILL.md`

