---
title: Resolve HITL operational blockers
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-507]
pr: 507
merge_sha: 11128130cb3be946e0ea5ab61b77629e5666d6d0
---

# Resolve HITL operational blockers

- **PR:** [#507](https://github.com/reddb-io/red-skills/pull/507)
- **Author:** @filipeforattini
- **Merge SHA:** `11128130cb3be946e0ea5ab61b77629e5666d6d0`
- **Format:** merged pull request

## Summary

Resolves operational ready-for-human blockers that already had AFK-produced work or stale validation state.\n\nCloses #352\nCloses #355\nCloses #402\nCloses #418\n\nAlso confirms #354 and #403 are already present on main and will be label-cleaned separately.\n\nValidation:\n- git diff --check origin/main..HEAD\n- pnpm -C src/apps/dev test -- process-issue supervisor recovery\n- pnpm -C src/apps/dev typecheck

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/507"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783288876&installation_id=129708444&pr_number=507&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F507&signature=fd17a3c58287f19d2e62f2deae9a79fd3b453e74640992b655e10bde47761f76"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(afk): rewrite SKILL.md execution layer to match sandcastle reali…
- docs(adr): fix memory ADRs 0010/0005/0027 against current src (#355)
- Add ADR pass-2 coherence notes
- feat(afk): cap stalled re-claims + clear stale blocked:* on promote (…

## Files changed

- `.red/adr/0005-memory-three-layer-reddb-architecture.md`
- `.red/adr/0009-dev-soft-uses-memory-one-directional.md`
- `.red/adr/0010-llm-extraction-via-reddb-ai-provider.md`
- `.red/adr/0013-dev-owns-codebase-understanding-surface.md`
- `.red/adr/0014-memory-owns-skill-telemetry-and-report-only-curation.md`
- `.red/adr/0016-dev-owns-the-mutating-skill-curator.md`
- `.red/adr/0026-afk-lifecycle-hooks-as-interceptors.md`
- `.red/adr/0027-memory-plugin-closed-loop-via-hooks-and-ci.md`
- `.red/adr/0028-promise-is-the-canonical-attempt-exit-signal.md`
- `.red/adr/0029-memory-runtime-ships-as-a-bundled-asset-fetched-by-a-bootstrap.md`
- `.red/agents/triage-labels.md`
- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/triage-labels.md`
- `src/apps/dev/src/commands/supervise.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/core/recovery.ts`
- `src/apps/dev/src/core/supervisor.ts`
- `src/apps/dev/src/runtime/supervisor-fs.ts`
- `src/apps/dev/tests/process-issue.test.ts`
- `src/apps/dev/tests/recovery.test.ts`
- `src/apps/dev/tests/supervisor.test.ts`

