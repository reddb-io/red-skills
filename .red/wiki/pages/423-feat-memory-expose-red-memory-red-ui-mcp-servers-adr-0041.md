---
title: feat(memory): expose red-memory + red-ui MCP servers (ADR 0041)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-423]
pr: 423
merge_sha: 65e2babb9e5eb9e5137f2417958d1a5959c5e7bf
---

# feat(memory): expose red-memory + red-ui MCP servers (ADR 0041)

- **PR:** [#423](https://github.com/reddb-io/red-skills/pull/423)
- **Author:** @filipeforattini
- **Merge SHA:** `65e2babb9e5eb9e5137f2417958d1a5959c5e7bf`
- **Format:** merged pull request

## Summary

## What

The memory plugin shipped a single `memory` MCP server. ADR 0041's target shape is **two** servers; this wires them in `plugins/memory/.mcp.json`:

- **`red-memory`** (data) — renamed from `memory`; runtime still fetched from the red-skills release via `scripts/bootstrap.mjs` (the red-memory repo split is #378, so only the server key changes for now).
- **`red-ui`** (visualizer) — added per red-ui's own README: `npx -y @reddb-io/ui@latest mcp --stdio` with `RED_UI_APP_URL=https://ui.reddb.io`.

## Why now / why safe

- The rename is safe: **zero `mcp__memory__*` references** exist anywhere in the repo, so no skill/doc breaks on the server-key change.
- red-ui's repo + v0.1.0 release exist and its README explicitly prescribes this exact `mcpServers` wiring for red-skills plugin manifests.

## ⚠️ Known blocker (external, not red-skills)

`red-ui` will **not connect until `@reddb-io/ui` is published to public npm** — it currently 404s on the registry, and the v0.1.0 release ships only the desktop/web app (rpm/deb/AppImage/zip), no MCP bundle. red-skills is now wired correctly and resolves the server the moment the package publishes. Tracking the publish is a **red-ui repo** task.

`red-memory` continues to serve from the red-skills release (the in-repo memory runtime) until the #378 repo split lands; the data MCP works today (runtime cached for 1.157.0 — the intermittent disconnect users saw was transient GitHub 502/504 on the release fetch, not a wiring bug).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/423"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783050859&installation_id=129708444&pr_number=423&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F423&signature=6009a2e387bd06d1001256254bc3546a7ebe7440fb1907143b6f3810f2acf38c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Updated MCP server configuration and renamed the memory server entry.

* **New Features**
  * Integrated a new UI server component for enhanced application capabilities.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(memory): expose red-memory + red-ui MCP servers (ADR 0041)

## Files changed

- `plugins/memory/.mcp.json`

