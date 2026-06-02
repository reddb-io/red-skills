---
title: fix(statusline): re-assert Codex tui.status_line on session_start (survives config resets)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-380]
pr: 380
merge_sha: 55ba5bf9eaf1e6e611fd7335788573535a1a96a5
---

# fix(statusline): re-assert Codex tui.status_line on session_start (survives config resets)

- **PR:** [#380](https://github.com/reddb-io/red-skills/pull/380)
- **Author:** @filipeforattini
- **Merge SHA:** `55ba5bf9eaf1e6e611fd7335788573535a1a96a5`
- **Format:** merged pull request

## Summary

## Problem
The Codex footer blanks on "every update". Unlike Claude (a command statusLine), Codex's footer is **global builtin config** (`~/.codex/config.toml` → `[tui].status_line`) with **no command hook**. When Codex rewrites `config.toml` (e.g. re-syncing plugin `[hooks.state]` on update) it can drop the `[tui]` section → footer gone.

## Fix
New `plugins/dev/hooks/ensure-codex-statusline.mjs`, wired as a **second Codex `SessionStart` hook**. It re-asserts `status_line`:
- **Additive only** — inserts `status_line` *only when absent*; never clobbers an operator's existing value.
- **Atomic** — temp file + `rename`, so a race with Codex's own writer can lose the update but can **never corrupt** `config.toml`.
- **Idempotent / best-effort** — re-running is a no-op; any error is swallowed and the hook still emits `{}` so session start is never blocked.

A reset self-heals on the next session start (1-session lag).

## Tested
- `[tui]` with `status_line` → no-op (respects existing).
- `[tui]` without `status_line` → inserts, preserves sibling keys.
- no `[tui]` → appends `[tui]` + `status_line`.
- idempotent re-run → exactly one `status_line`.
- live run against the real `~/.codex/config.toml` → no change (already set), exit 0.

Note: Codex's footer can only show **builtin widgets** — the AFK worker block still can't render there (track via `/afk monitor`). This just keeps the chosen widget set from vanishing on update.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/380"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782995089&installation_id=129708444&pr_number=380&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F380&signature=71f06053b54d492eccee50c4af896ef46498a034363bff0fd8f56ff192ec129c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(statusline): re-assert Codex tui.status_line on session_start

## Files changed

- `plugins/dev/hooks/codex.hooks.json`
- `plugins/dev/hooks/ensure-codex-statusline.mjs`
- `plugins/dev/skills/engineering/statusline/SKILL.md`

