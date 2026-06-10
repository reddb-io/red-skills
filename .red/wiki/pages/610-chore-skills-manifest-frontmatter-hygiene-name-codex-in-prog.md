---
title: chore(skills): manifest/frontmatter hygiene — name:, Codex in-progress, git -C lock (#593)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-610]
pr: 610
merge_sha: 80079ecf42a5a4d59843433b2895bc2026814ed7
---

# chore(skills): manifest/frontmatter hygiene — name:, Codex in-progress, git -C lock (#593)

- **PR:** [#610](https://github.com/reddb-io/red-skills/pull/610)
- **Author:** @filipeforattini
- **Merge SHA:** `80079ecf42a5a4d59843433b2895bc2026814ed7`
- **Format:** merged pull request

## Summary

Closes #593. Landed via the PRD #567 parallel-landing workflow — a worktree-isolated agent implemented + tested the slice and ran the dev gate green (typecheck + the dev vitest suite) before pushing. Part of PRD #567.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/610"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783624412&installation_id=129708444&pr_number=610&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F610&signature=27bc066b9da66fa978262c68a841baeccc92f6e00386dacf3e4dc03de97aed3d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **Bug Fixes**
  * Enhanced git command classifier to properly skip global options when identifying commands, improving branch-lock reliability.
  * Added missing metadata field to skill documentation.

* **Tests**
  * Added manifest validation tests to ensure skill documentation compliance.
  * Extended command classifier tests to verify proper global option handling.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(skills): manifest and frontmatter hygiene across the dev plugin
- Merge remote-tracking branch 'origin/main' into fix/afk-593

## Files changed

- `CHANGES.md`
- `plugins/dev/.codex-plugin/plugin.json`
- `plugins/dev/skills/engineering/model-tier-policy/SKILL.md`
- `plugins/dev/skills/misc/branch-lock/scripts/lib/git-command-classifier.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/tests/git-command-classifier.test.sh`
- `src/apps/dev/tests/manifest-parity.test.ts`

