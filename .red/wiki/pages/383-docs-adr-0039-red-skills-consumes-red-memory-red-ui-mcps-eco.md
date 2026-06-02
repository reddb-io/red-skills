---
title: docs(adr): 0039 — red-skills consumes red-memory + red-ui MCPs (ecosystem split)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-383]
pr: 383
merge_sha: 197c54d4aafaa9804737bf1de1edd028a3379d4a
---

# docs(adr): 0039 — red-skills consumes red-memory + red-ui MCPs (ecosystem split)

- **PR:** [#383](https://github.com/reddb-io/red-skills/pull/383)
- **Author:** @filipeforattini
- **Merge SHA:** `197c54d4aafaa9804737bf1de1edd028a3379d4a`
- **Format:** merged pull request

## Summary

Records the direction designed in /start and tracked by #378: red-skills stops building memory and becomes a consumer of the red-memory and red-ui MCPs (fetched from their GitHub releases). `src/apps/memory` migrates to the red-memory repo; data MCP `memory`→`red-memory` (tools keep `memory_*`); visualizer = red-ui's `ui-mcp`. Partially reverses ADR 0034 for memory only. Numbered 0039 because 0038 was the merged afk-bundle-fetch ADR.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/383"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782996849&installation_id=129708444&pr_number=383&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F383&signature=57baa208423024869155e889b0dbc107b8f7fc5cf0c0330f81d68efddfe9f7dc"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(adr): 0039 — red-skills consumes red-memory and red-ui MCPs; sto…

## Files changed

- `.red/adr/0039-red-skills-consumes-red-memory-and-red-ui-mcps.md`

