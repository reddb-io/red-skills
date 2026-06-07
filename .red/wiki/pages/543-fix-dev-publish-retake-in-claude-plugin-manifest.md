---
title: fix(dev): publish retake in claude plugin manifest
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-543]
pr: 543
merge_sha: 08a5b783ea7dac8f406337a0dbb572359fdea20e
---

# fix(dev): publish retake in claude plugin manifest

- **PR:** [#543](https://github.com/reddb-io/red-skills/pull/543)
- **Author:** @filipeforattini
- **Merge SHA:** `08a5b783ea7dac8f406337a0dbb572359fdea20e`
- **Format:** merged pull request

## Summary

Adds ./skills/engineering/retake to plugins/dev/.claude-plugin/plugin.json so the Claude plugin skill list matches the published SKILL.md tree. Validation: scripts/validate-install-metadata.sh and git diff --check. Closes #542

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/543"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783389008&installation_id=129708444&pr_number=543&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F543&signature=918b0d3203a822edb33350d0bdbd69fe39c5b85b84280cd0f196feb34f5fe275"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added a new engineering skill capability to the system, extending available functionality.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(dev): publish retake in claude plugin manifest

## Files changed

- `plugins/dev/.claude-plugin/plugin.json`

