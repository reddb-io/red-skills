---
title: docs(memory): ADR 0036 — transports are adapters over the operation registry
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-375]
pr: 375
merge_sha: 95e9b726ab9326e9dcd6c6c8722ba025491a88ef
---

# docs(memory): ADR 0036 — transports are adapters over the operation registry

- **PR:** [#375](https://github.com/reddb-io/red-skills/pull/375)
- **Author:** @filipeforattini
- **Merge SHA:** `95e9b726ab9326e9dcd6c6c8722ba025491a88ef`
- **Format:** merged pull request

## Summary

Records the architectural direction surfaced via `/improve-codebase-architecture` and sliced into #370–#374.

## What

- **ADR 0036** — the Memory operation registry is the single seam for the read-only operation family; CLI/MCP/HTTP are Transport adapters over it (MCP already is). Adds `inputBinding` + `outputKind` as the facets that let CLI/HTTP become generic adapters. Mutating/infra routes stay hand-wired.
- **memory glossary** — adds **Memory operation**, **Memory operation registry**, **Transport adapter**.

## Why now

Issues #370–#374 reference ADR 0036; landing it on `main` so AFK worktrees picking up those slices see the cited context. Docs only — no code change.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/375"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782935213&installation_id=129708444&pr_number=375&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F375&signature=01acb4f5adb72839cb3031e3a7326afdfa68cdb73a727f5dc303f56459e2d222"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated internal architecture documentation and terminology definitions for the Memory system.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(memory): ADR 0036 — transports are adapters over the operation r…

## Files changed

- `.red/adr/0036-memory-transports-are-adapters-over-the-operation-registry.md`
- `.red/contexts/memory/CONTEXT.md`

