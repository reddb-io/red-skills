---
title: ADR record propagation receipt for issue 420
type: synthesis
tags: [adr, propagation, memory, wiki]
created: 2026-06-06
updated: 2026-06-06
sources: [issue-420, adr-index]
---

# ADR record propagation receipt for issue 420

## Scope

Propagation pass for PRD #414 after #415, #416, #417, #418, and #419 closed.

## Wiki

`/wiki lint` equivalent checks were run against `.red/wiki`: target ADR
references, markdown links, stale `src/domains` claims, and target contradictions.
The pages below were re-ingested by updating their current-record notes:

- `pages/288-refactor-monorepo-src-domains-shared-per-plugin-bundles-dyna.md`
- `pages/376-refactor-dev-ship-dev-runtime-as-fetched-asset-not-committed.md`
- `pages/386-docs-adr-resolve-0039-collision-consume-0041-add-adr-index-m.md`
- `pages/390-feat-config-unify-plugin-config-under-red-config-yaml-plugin.md`
- `pages/391-fix-config-memory-built-in-handlers-use-autohooks-not-hooks.md`
- `pages/400-feat-afk-attempt-progress-guard-abort-a-stalled-agent-park-t.md`
- `pages/401-feat-afk-externalize-proof-of-life-heartbeat-record-state-fi.md`
- `pages/229-feat-memory-ship-runtime-as-bundled-release-asset-bootstrap.md`
- `pages/265-merge-227-afk-make-promise-sentinel-the-canonical-attempt-ex.md`

No target dangling or contradictory claims remain after this pass. Historical PR
summaries still preserve the original merged PR wording; current ADR state is
called out in explicit "Current ADR record" sections.

## Memory

Memory refresh was run for:

- `.red/adr/0005-memory-three-layer-reddb-architecture.md`
- `.red/adr/0046-single-global-red-dir.md`
- `.red/adr/0034-monorepo-src-domains-with-per-plugin-bundles.md`
- `.red/adr/0028-promise-is-the-canonical-attempt-exit-signal.md`
- `.red/adr/0013-dev-owns-codebase-understanding-surface.md`
- `.red/adr/0014-memory-owns-skill-telemetry-and-report-only-curation.md`
- `.red/adr/0016-dev-owns-the-mutating-skill-curator.md`
- `.red/adr/0026-afk-lifecycle-hooks-as-interceptors.md`
- `.red/adr/0029-memory-runtime-ships-as-a-bundled-asset-fetched-by-a-bootstrap.md`
- `.red/adr/0009-dev-soft-uses-memory-one-directional.md`
- `.red/adr/0042-plugin-config-unified-under-red-config-yaml.md`
- `.red/adr/0044-afk-attempt-progress-guard.md`
- `.red/adr/0045-afk-externalized-proof-of-life.md`
- `.red/adr/INDEX.md`

Initial ADR refresh result: 14 files, 330 nodes, 210 edges, 14 docs, 344 graph
elements added, 0 updated, 0 skipped, 0 stale.

The updated wiki pages and this receipt were then refreshed into Memory so the
graph reflects the final wiki propagation state. The final receipt refresh updated
the existing receipt doc with 0 skipped and 0 stale records.

The graph had 0 existing nodes before refresh, so there were no pre-existing
nodes citing renumbered or superseded ADR provenance to `memory supersede`.
