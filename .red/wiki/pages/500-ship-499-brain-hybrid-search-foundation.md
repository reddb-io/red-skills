---
title: ship: #499 Brain hybrid search foundation
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-500]
pr: 500
merge_sha: 825abc789e1945b84d1e8f9d36b632c7eb628664
---

# ship: #499 Brain hybrid search foundation

- **PR:** [#500](https://github.com/reddb-io/red-skills/pull/500)
- **Author:** @filipeforattini
- **Merge SHA:** `825abc789e1945b84d1e8f9d36b632c7eb628664`
- **Format:** merged pull request

## Summary

Interactive /ship landing for #499.

Closes #499

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/500"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783274037&installation_id=129708444&pr_number=500&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F500&signature=ea054e797254d3aa2355a7b3f9f4e27b1cbb3f26a1e26173f77e12a669bdeaf3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Search results now display detailed ranking information showing which factors contributed to each result's position, including lexical matches, tags, artifact type, and graph connections.

* **Documentation**
  * Updated Brain and search skill documentation to explain the hybrid ranking system and guidance on using score breakdowns to explain result relevance.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add Brain hybrid search scoring

## Files changed

- `plugins/brain/README.md`
- `plugins/brain/skills/core/search/SKILL.md`
- `src/apps/brain/src/store.ts`
- `src/apps/brain/tests/store.test.ts`

