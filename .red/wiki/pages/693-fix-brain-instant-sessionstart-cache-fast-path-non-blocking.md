---
title: fix(brain): instant SessionStart — cache fast-path + non-blocking hook
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-693]
pr: 693
merge_sha: 78fbcf228771b02e7f642721baa80498d1f2babc
---

# fix(brain): instant SessionStart — cache fast-path + non-blocking hook

- **PR:** [#693](https://github.com/reddb-io/red-skills/pull/693)
- **Author:** @filipeforattini
- **Merge SHA:** `78fbcf228771b02e7f642721baa80498d1f2babc`
- **Format:** merged pull request

## Summary

Brain's SessionStart hook blocked every session **~17 s**. Diagnosed live: two independent causes, two fixes.

**1. Cache fast-path (`bootstrap.mjs`)** — it re-fetched the manifest and re-validated assets from GitHub on every start, **re-downloading the ~24 MB `red` binary**. Added a fast-path: when the version-keyed cache already has all three assets, return them and skip the network (assets are sha256-verified on write; a release version is immutable). **Verified: 0 GitHub sockets on a warm start** (was 2).

**2. Non-blocking hook (`claude.hooks.json` + `codex.hooks.json`)** — even with the network gone it still blocked **~15 s** on the brain runtime's local SessionStart handler. The hook now forks the bootstrap to the background and returns `{}` immediately. Codex variant drains stdin synchronously first, then cleans its tmp inside the background subshell (no EXIT-trap race).

**Result: SessionStart returns in ~10 ms** (was ~17 s); warm-up completes off-session. Brain MCP server unaffected (separate process). Memory's hook was already fast (~1 s) — unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/693"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783770321&installation_id=129708444&pr_number=693&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F693&signature=08b718d11a8bfc88bc6d031423314c429a8e9a10f2802257e384e0d537ae41d5"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Performance**
  * Optimized startup performance through intelligent caching of runtime artifacts. Cached components are now reused across sessions, reducing unnecessary downloads and verification checks.

* **Chores**
  * Enhanced session initialization with improved output suppression and graceful error handling for more stable startup behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(brain): instant SessionStart — cache fast-path + non-blocking hook

## Files changed

- `plugins/brain/hooks/claude.hooks.json`
- `plugins/brain/hooks/codex.hooks.json`
- `plugins/brain/scripts/bootstrap.mjs`

