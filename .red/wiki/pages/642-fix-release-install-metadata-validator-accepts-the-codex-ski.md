---
title: fix(release): install-metadata validator accepts the codex skills bucket array
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-642]
pr: 642
merge_sha: 81c09da6d9d764939ff5709a1cc113342d908492
---

# fix(release): install-metadata validator accepts the codex skills bucket array

- **PR:** [#642](https://github.com/reddb-io/red-skills/pull/642)
- **Author:** @filipeforattini
- **Merge SHA:** `81c09da6d9d764939ff5709a1cc113342d908492`
- **Format:** merged pull request

## Summary

Closes #641.

Every `red-release` since PR #610 fails at `Validate install metadata` with `dev: Codex plugin must expose ./skills/` — #610 intentionally moved the dev Codex manifest to an array of published buckets (excluding `in-progress/`), but `scripts/validate-install-metadata.sh:47` still required the exact legacy string. Failing runs: 27271937186 (#639 merge), 27253767736 (#578 merge). Latest release is stuck at v1.180.6, so the #637 hard-cap fix has no bundle.

The validator now accepts either the legacy `"./skills/"` string (memory, brain — unchanged) or a non-empty array where every entry is a `./skills/<bucket>/` path, and additionally verifies each listed bucket exists on disk.

Verified locally: `bash scripts/validate-install-metadata.sh` passes on main's manifests; mutating the dev manifest to a nonexistent bucket fails with `Codex skills bucket not found on disk`.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/642"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783682654&installation_id=129708444&pr_number=642&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F642&signature=475af5c08c6ae2e765e79d795ea05bc764075194700a38056bb70423d2cbbf7f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Enhanced plugin configuration validation to support both legacy and array-based skills path formats.
  * Added verification that referenced skills buckets exist on disk.
  * Improved validation error messages for better debugging.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(release): install-metadata validator accepts the codex skills buc…

## Files changed

- `scripts/validate-install-metadata.sh`

