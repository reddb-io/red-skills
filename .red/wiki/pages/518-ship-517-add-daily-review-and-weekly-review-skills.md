---
title: ship: #517 Add /daily-review and /weekly-review skills
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-518]
pr: 518
merge_sha: 806ec240804a6ed8434d7506e5816bb25cd31901
---

# ship: #517 Add /daily-review and /weekly-review skills

- **PR:** [#518](https://github.com/reddb-io/red-skills/pull/518)
- **Author:** @filipeforattini
- **Merge SHA:** `806ec240804a6ed8434d7506e5816bb25cd31901`
- **Format:** merged pull request

## Summary

Interactive /ship landing for #517.

Closes #517

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/518"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783359960&installation_id=129708444&pr_number=518&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F518&signature=05621a8abe80fc178fe593382205617f76a421844efb06c539ae6fbca816c101"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `daily-review` command for daily operational reviews covering metrics from yesterday midnight to now
  * Added `weekly-review` command for six-day operational reviews with `--json` output support
  * Both commands generate reports on deliverables, worker activity, blockers, and cycle times

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(dev): add daily and weekly review skills

## Files changed

- `README.md`
- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/daily-review/SKILL.md`
- `plugins/dev/skills/engineering/weekly-review/SKILL.md`
- `src/apps/dev/src/cli.ts`
- `src/apps/dev/src/commands/activity-review.ts`
- `src/apps/dev/src/core/activity-review.ts`
- `src/apps/dev/tests/activity-review.test.ts`
- `src/apps/dev/tests/cli-routing.test.ts`

