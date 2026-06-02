---
title: fix(statusline): render from cached bundle, not the fetch-launcher (survives plugin updates)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-379]
pr: 379
merge_sha: 9e53fd1d7b6e948064d863b1bf966babeb4e5036
---

# fix(statusline): render from cached bundle, not the fetch-launcher (survives plugin updates)

- **PR:** [#379](https://github.com/reddb-io/red-skills/pull/379)
- **Author:** @filipeforattini
- **Merge SHA:** `9e53fd1d7b6e948064d863b1bf966babeb4e5036`
- **Format:** merged pull request

## Summary

## Problem
Every plugin update broke the Claude statusline. Since **ADR 0038**, `bin/afk.mjs` is a ~6 KB launcher that **fetches** the runtime bundle from the GitHub release. The Claude `statusLine` command ran that launcher directly, so each update landed a new version whose bundle wasn't cached — triggering a **synchronous network download inside the statusline render**, which blows the render timeout (blank line) or fails outright if the version's release asset isn't published yet. (Pre-0038, `afk.mjs` was the full committed bundle, so the line rendered instantly.)

## Fix
Point the statusLine at the **newest already-fetched bundle** (`~/.cache/red-skills/bundles/dev-*.bundle.min.mjs`) — no network in the hot path. An update never blanks the line; it keeps rendering the last good bundle until a normal `afk` run re-fetches the new one. Falls back to the launcher only when the cache is empty (first-ever install).

Verified: `… | node ~/.cache/red-skills/bundles/dev-1.148.0.bundle.min.mjs statusline` → `red-skills (main) · Opus`, exit 0, offline.

## Scope
- Updates the `.claude/settings.json` command template, the "why" rationale, and the verify snippet in the statusline `SKILL.md`.
- **Claude only.** The Codex footer is native `tui.status_line` config (no command/bundle), so this doesn't touch it — Codex durability is a separate follow-up (re-assert `[tui].status_line` on session_start via a TOML-safe writer).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/379"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782994224&installation_id=129708444&pr_number=379&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F379&signature=759026ef0ee5aaf09a323e659bb1d80d5ac5ed1841bb7b1e7576420382b939ab"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(statusline): render from the cached bundle, not the fetch-launcher

## Files changed

- `plugins/dev/skills/engineering/statusline/SKILL.md`

