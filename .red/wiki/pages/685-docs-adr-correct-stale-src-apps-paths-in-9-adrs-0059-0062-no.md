---
title: docs(adr): correct stale src/apps paths in 9 ADRs + 0059→0062 note (closes #682)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-685]
pr: 685
merge_sha: a4623d977ee76f7504cd9ce5075ee9206c1689f3
---

# docs(adr): correct stale src/apps paths in 9 ADRs + 0059→0062 note (closes #682)

- **PR:** [#685](https://github.com/reddb-io/red-skills/pull/685)
- **Author:** @filipeforattini
- **Merge SHA:** `a4623d977ee76f7504cd9ce5075ee9206c1689f3`
- **Format:** merged pull request

## Summary

Slice 1/3 of PRD #681 (the `/dev:review-adrs` reconciliation). Closes #682.

After ADR 0060 relocated `src/apps/*`→`apps/*` and `src/packages/*`→`packages/*`, nine still-accepted ADRs cited the old paths. This reconciles the **prose** without touching any standing decision.

- **Path swap** `src/apps/`→`apps/`, `src/packages/`→`packages/` in 0027, 0036, 0038, 0039, 0041, 0042, 0047, 0052, 0057.
- **Live-claim fixes** (the judgment bit from Q01): 0041 (`apps/memory` remains the live source) and 0047 (the current `apps/dev/src/core/process-issue.ts`) — both asserted now-wrong live paths.
- **Two bare historical phrases** reworded so no stale literal survives (0041 "monorepo `apps` domains", 0047 "a tree predating the monorepo relocation").
- **0059 Status** gains a "Refined by ADR 0062" note — 0062 already cited 0059, this closes the bidirectional link.

**Gate:** `git grep -lE 'src/apps|src/packages' -- .red/adr/0*.md` now returns only `0034` + `0060` (both legitimately describe the pre-relocation layout with a relocation note). No decision reversed.

Follow-ups in the PRD: #683 (INDEX refresh) and #684 (wiki re-ingest), both `req:682` → auto-promote when this closes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/685"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783745544&installation_id=129708444&pr_number=685&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F685&signature=503466254bc049c4bed77e339c9edcf1c7083f1e39bcde08a2a303c72f50b05d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(adr): correct stale src/apps paths in 9 ADRs + add 0059->0062 re…

## Files changed

- `.red/adr/0027-memory-plugin-closed-loop-via-hooks-and-ci.md`
- `.red/adr/0036-memory-transports-are-adapters-over-the-operation-registry.md`
- `.red/adr/0038-dev-runtime-ships-as-a-fetched-asset-not-a-committed-bundle.md`
- `.red/adr/0039-plugin-entrypoints-share-one-source.md`
- `.red/adr/0041-red-skills-consumes-red-memory-and-red-ui-mcps.md`
- `.red/adr/0042-plugin-config-unified-under-red-config-yaml.md`
- `.red/adr/0047-afk-salvages-no-sentinel-branch-that-passes-feedback.md`
- `.red/adr/0052-one-bundle-naming-convention-under-dist.md`
- `.red/adr/0057-brain-depends-on-fetched-never-vendored-red-hermes-black-box.md`
- `.red/adr/0059-opencode-is-the-third-afk-runner-over-openrouter.md`

