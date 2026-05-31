---
title: chore(afk): rebuild committed bin/afk.mjs from current source
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-320]
pr: 320
merge_sha: 208eb2933dbd2bf85e15b096bf133d9678844f0f
---

# chore(afk): rebuild committed bin/afk.mjs from current source

- **PR:** [#320](https://github.com/reddb-io/red-skills/pull/320)
- **Author:** @filipeforattini
- **Merge SHA:** `208eb2933dbd2bf85e15b096bf133d9678844f0f`
- **Format:** merged pull request

## Summary

The committed dev runtime had drifted 8 merges behind main (missing attempt-outcome, doLanding/terminalFailure, exec seam, RED_AFK_SANDBOX, req:N/blocked/auto-recovery). Since dev runs off this committed bundle today (release-fetch dormant), main was shipping stale runtime. Rebuilt via the workflow's bundle:bin recipe; new symbols present, reap runs native. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/320"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782795712&installation_id=129708444&pr_number=320&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F320&signature=96163dbd373053805bb8bb4b622429761dd8d5c4cd31d01de91485192f5459bc"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- chore(afk): rebuild committed bin/afk.mjs from current source [skip r…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`

