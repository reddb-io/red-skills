---
title: docs(readme): redact AFK usage from public README + fix dev bundle CI build
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-321]
pr: 321
merge_sha: 953e4f89897011b189c3d82fdf9dacb28f827d2e
---

# docs(readme): redact AFK usage from public README + fix dev bundle CI build

- **PR:** [#321](https://github.com/reddb-io/red-skills/pull/321)
- **Author:** @filipeforattini
- **Merge SHA:** `953e4f89897011b189c3d82fdf9dacb28f827d2e`
- **Format:** merged pull request

## Summary

Removes the AFK usage section (## ⚡ /afk walkthrough + RTK-before-afk + TOC link) from the public README. Also fixes the red-release build that failed on 'Could not resolve cli-args-parser' (install src/shared so esbuild resolves the dep from shared's node_modules). Verified the fix deterministically. This merge intentionally triggers the release → v1.142.0.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/321"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782796931&installation_id=129708444&pr_number=321&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F321&signature=8bd6954f0397394482b039ecfe0ce713a3ee74dafedf890d9b287182857ae6ae"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(readme): remove the AFK usage section from the public README; ci…

## Files changed

- `.github/workflows/red-release.yml`
- `README.md`

