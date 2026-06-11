---
title: chore(legacy): remove the stale committed memory-runtime-manifest.json (closes #597)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-690]
pr: 690
merge_sha: 7504facb2b7f96511fc2ee456aa1ebe16cbf5a9a
---

# chore(legacy): remove the stale committed memory-runtime-manifest.json (closes #597)

- **PR:** [#690](https://github.com/reddb-io/red-skills/pull/690)
- **Author:** @filipeforattini
- **Merge SHA:** `7504facb2b7f96511fc2ee456aa1ebe16cbf5a9a`
- **Format:** merged pull request

## Summary

PRD #567 slice. Two of the three legacy targets were **already cleaned** on current main (the `dist-bundle/*` memory bundles, and the `dist-bundle/**` turbo output). The remaining one: the committed `apps/memory/memory-runtime-manifest.json` pinned to **1.146.1** (pkg is 1.189.0) — ADR 0052/0041.

**Safety gate (proven before deleting):** nothing live reads the committed manifest.
- `plugins/memory/scripts/bootstrap.mjs` **fetches** the manifest from the GitHub Release into a version-keyed cache.
- `red-release.yml` **writes** `dist/memory-runtime-manifest.json` fresh each build.
- A grep for any local `readFileSync`/`require` of `apps/memory/memory-runtime-manifest.json` is empty.

So removing it can't affect build/release. **Out of scope:** `plugins/brain/dist-bundle/*` is brain's, a separate ADR-0052 cleanup.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/690"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783747349&installation_id=129708444&pr_number=690&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F690&signature=afe206ded4821a9298bc3fc70861a2f5417bdac2c0757f05dee8ee50371ed37b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Removed runtime manifest configuration.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(legacy): remove the stale committed memory-runtime-manifest.jso…

## Files changed

- `apps/memory/memory-runtime-manifest.json`

