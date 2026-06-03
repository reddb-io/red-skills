---
title: chore: gitignore .turbo build cache
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-461]
pr: 461
merge_sha: ba19a21fec2458e19d1175168f63d7275d7f34b3
---

# chore: gitignore .turbo build cache

- **PR:** [#461](https://github.com/reddb-io/red-skills/pull/461)
- **Author:** @filipeforattini
- **Merge SHA:** `ba19a21fec2458e19d1175168f63d7275d7f34b3`
- **Format:** merged pull request

## Summary

Turbo's local cache (`.turbo/`) was untracked at the repo root and would be swept into an AFK `chore(afk): pre-merge snapshot` commit (the WIP-eating footgun). Ignore it repo-wide (`.turbo/` + `**/.turbo/`).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/461"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783097123&installation_id=129708444&pr_number=461&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F461&signature=ee6424efffc16f17fb8fcb60e6d3618fd6cda46930e398adb3231f055f262ec8"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Updated `.gitignore` to exclude Turbo build cache directories, ensuring locally generated build artifacts are not committed to the repository.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore: gitignore .turbo build cache

## Files changed

- `.gitignore`

