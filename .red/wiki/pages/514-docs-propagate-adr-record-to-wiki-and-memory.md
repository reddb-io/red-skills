---
title: docs: propagate ADR record to wiki and Memory
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-514]
pr: 514
merge_sha: 36cd0f84cfe3a0136d4bc54276b440a93f50ceb5
---

# docs: propagate ADR record to wiki and Memory

- **PR:** [#514](https://github.com/reddb-io/red-skills/pull/514)
- **Author:** @filipeforattini
- **Merge SHA:** `36cd0f84cfe3a0136d4bc54276b440a93f50ceb5`
- **Format:** merged pull request

## Summary

Closes #420

## Summary
- updated wiki pages with current ADR record notes for PRD #414 follow-up
- added ADR propagation receipt and wiki log entry
- refreshed Memory cache after ADR/wiki ingestion

## Verification
- wiki link lint: 99 files, 0 bad links
- Memory ADR refresh: 14 files, 330 nodes, 210 edges, 0 skipped, 0 stale
- Memory receipt refresh: 1 file, 0 skipped, 0 stale

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/514"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783300800&installation_id=129708444&pr_number=514&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F514&signature=f4564e0d86579816fbc2cacc2e23f7ab63d9bd587cf469c38406881433163f90"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs: propagate ADR record to wiki and Memory

## Files changed

- `.red/memory/graph.result-cache.l2`
- `.red/wiki/index.md`
- `.red/wiki/log.md`
- `.red/wiki/pages/229-feat-memory-ship-runtime-as-bundled-release-asset-bootstrap.md`
- `.red/wiki/pages/265-merge-227-afk-make-promise-sentinel-the-canonical-attempt-ex.md`
- `.red/wiki/pages/288-refactor-monorepo-src-domains-shared-per-plugin-bundles-dyna.md`
- `.red/wiki/pages/376-refactor-dev-ship-dev-runtime-as-fetched-asset-not-committed.md`
- `.red/wiki/pages/386-docs-adr-resolve-0039-collision-consume-0041-add-adr-index-m.md`
- `.red/wiki/pages/390-feat-config-unify-plugin-config-under-red-config-yaml-plugin.md`
- `.red/wiki/pages/391-fix-config-memory-built-in-handlers-use-autohooks-not-hooks.md`
- `.red/wiki/pages/400-feat-afk-attempt-progress-guard-abort-a-stalled-agent-park-t.md`
- `.red/wiki/pages/401-feat-afk-externalize-proof-of-life-heartbeat-record-state-fi.md`
- `.red/wiki/pages/420-adr-record-propagation-receipt.md`

