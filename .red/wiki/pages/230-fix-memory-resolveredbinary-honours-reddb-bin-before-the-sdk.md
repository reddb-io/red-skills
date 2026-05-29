---
title: fix(memory): resolveRedBinary honours REDDB_BIN before the SDK package lookup
type: source
tags: [pr, merged]
created: 2026-05-29
updated: 2026-05-29
sources: [pr-230]
pr: 230
merge_sha: 95675c4dd02c2db9a52a6ca34a2a54fc28ae044e
---

# fix(memory): resolveRedBinary honours REDDB_BIN before the SDK package lookup

- **PR:** [#230](https://github.com/reddb-io/red-skills/pull/230)
- **Author:** @filipeforattini
- **Merge SHA:** `95675c4dd02c2db9a52a6ca34a2a54fc28ae044e`
- **Format:** merged pull request

## Summary

Follow-up to #229 / ADR 0029. The v1.127.0 bundle threw `Cannot find package '@reddb-io/sdk'` on the SessionStart path: `resolveRedBinary()` fell back to `import.meta.resolve("@reddb-io/sdk")`, which throws in the bundled runtime (no node_modules). Now honours `REDDB_BIN` first (the path the bootstrap sets; the SDK's canonical override).

**Caught by an end-to-end bootstrap run** against the published v1.127.0 release — the bootstrap downloaded + checksum-verified `memory-cli.mjs` + `red` correctly, but the CLI threw on delegation. With this fix, the same run executes the SessionStart hook fully (spawns `red`, real recall output). Amends ADR 0029's incorrect "no refactor needed" claim.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/230"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782605945&installation_id=129708444&pr_number=230&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F230&signature=28f0cc5a2aab8123aed7fd430818b113aa836a423dfddf53c420c40c262872d4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(memory): resolveRedBinary honours REDDB_BIN before the SDK packag…

## Files changed

- `.red/adr/0029-memory-runtime-ships-as-a-bundled-asset-fetched-by-a-bootstrap.md`
- `plugins/memory/src/vcs-commit.ts`

