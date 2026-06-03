---
title: feat(memory): add /memory:view — open the graph in red-ui (ADR 0041)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-424]
pr: 424
merge_sha: 540759f23dbb0f9912eceade4f1aad312878f9e8
---

# feat(memory): add /memory:view — open the graph in red-ui (ADR 0041)

- **PR:** [#424](https://github.com/reddb-io/red-skills/pull/424)
- **Author:** @filipeforattini
- **Merge SHA:** `540759f23dbb0f9912eceade4f1aad312878f9e8`
- **Format:** merged pull request

## Summary

## What

A new `memory` core skill — **`/memory:view`** — that turns "show me the memory graph" into a concrete action. It resolves the graph store, picks a red-ui view, and opens it **host-aware**:

- **GUI / MCP-Apps host** (Claude Desktop, claude.ai, VS Code, Cursor): calls the `red-ui` MCP tool `open_red_ui` with `connectionUrl` = the store (`.red/memory/graph.rdb`, or `plugins.memory.storePath`) and `view` (default `cluster` = the graph). red-ui spawns a local single-writer `red server` for the file and renders the workspace embedded in chat.
- **Terminal host** (Claude Code): MCP Apps render a `ui://` resource in a sandboxed iframe — a terminal has no iframe surface — so it falls back to the browser **Workbench** (`memory serve`).

## Why

After wiring the `red-ui` MCP into the memory plugin (#423), there was no affordance that actually *opens* the graph — the user had to know to call `open_red_ui` with the right `connectionUrl` by hand. This closes that gap: the data path is RedDB-over-HTTP (the MCP bridge only passes connection + view), and this skill encodes the store resolution + the host-aware open/fallback.

## Notes

- **Read-only**: never mutates the store, never seeds a token in any URL (red-ui seeds only the non-secret endpoint + route; tokens go over the postMessage channel).
- Registered in `plugins/memory/.claude-plugin/plugin.json` (codex uses the `./skills/` wildcard — no edit) + the core bucket README + the root README surfaces table.
- If Memory is `markdown-only` / the store is absent, the skill routes the user to `/memory:init` + `/memory:ingest` instead of inventing a connection.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/424"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783074287&installation_id=129708444&pr_number=424&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F424&signature=bbd33011c579b1d6b81442535a1d2af7d47d10170c7293f1b4f677dc05e77fbf"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Introduced Memory graph visualization capability with red-ui support for graphical environments and Workbench browser fallback for terminal environments.

* **Documentation**
  * Updated documentation with new Memory view skill specifications, including configuration options and usage guidance.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(memory): add /memory:view — open the graph in red-ui (ADR 0041)

## Files changed

- `README.md`
- `plugins/memory/.claude-plugin/plugin.json`
- `plugins/memory/skills/core/README.md`
- `plugins/memory/skills/core/view/SKILL.md`

