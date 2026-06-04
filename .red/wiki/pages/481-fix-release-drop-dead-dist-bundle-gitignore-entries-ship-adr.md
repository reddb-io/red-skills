---
title: fix(release): drop dead dist-bundle/ gitignore entries + ship ADR 0052 naming
type: source
tags: [pr, merged]
created: 2026-06-04
updated: 2026-06-04
sources: [pr-481]
pr: 481
merge_sha: 4e75b93c2668bd33c8ce32cfb08db3a27c32b6a7
---

# fix(release): drop dead dist-bundle/ gitignore entries + ship ADR 0052 naming

- **PR:** [#481](https://github.com/reddb-io/red-skills/pull/481)
- **Author:** @filipeforattini
- **Merge SHA:** `4e75b93c2668bd33c8ce32cfb08db3a27c32b6a7`
- **Format:** merged pull request

## Summary

Follow-up to #480 (ADR 0052). Removes the now-dead `dist-bundle/` and `memory-runtime-manifest.json` gitignore rules (that output no longer exists; manifests moved into `./dist/`).

Doubles as the **release carrier**: #480 merged as `build(release):` which is a no-bump type, so the new `./dist/` asset naming has not actually shipped. This `fix:` triggers the next release, which runs the modified `red-release` workflow for the first time and publishes the normalized `dist/<app>.bundle.min.mjs` assets.

After merge I will smoke-test the memory/brain bootstrap fetch against the new release.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/481"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783129766&installation_id=129708444&pr_number=481&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F481&signature=864ab7e86dff6fc3026b7c97dec2483a693d320f286d63d5048953fad14fab05"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Updated Git configuration to track previously ignored build artifacts and project manifest files in version control, improving repository consistency.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(release): drop dead dist-bundle/ + memory-runtime-manifest gitign…

## Files changed

- `.gitignore`
- `src/apps/memory/.gitignore`

