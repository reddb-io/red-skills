---
title: fix(afk): native fleet supervisor — poll cadence + real stall-reaper IO
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-285]
pr: 285
merge_sha: a5dd8e01669d45ef1414fbe65c0d264694e25073
---

# fix(afk): native fleet supervisor — poll cadence + real stall-reaper IO

- **PR:** [#285](https://github.com/reddb-io/red-skills/pull/285)
- **Author:** @filipeforattini
- **Merge SHA:** `a5dd8e01669d45ef1414fbe65c0d264694e25073`
- **Format:** merged pull request

## Summary

Resolves the supervisor parts of #284: the native `runSupervisor` busy-spun (no inter-tick sleep) and `buildSupervisorDeps` wired the stall-reaper IO as no-ops (making it reap healthy workers). Adds `RED_AFK_POLL_S` cadence + injected `proc.sleep`, and backs inspectTree (ps, conservative-busy on error), agentLaneMtime, iter-dir resolution, and gh closures with real IO. 543 tests; bundle builds; monitor/reap still native. Only the real-fleet E2E remains in #284.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/285"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782746084&installation_id=129708444&pr_number=285&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F285&signature=eff3f3290e859120ceaec4b7196959b9153686b4bb8c8a78e81768179ee8bba3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): make the native fleet supervisor safe — poll cadence + real…

## Files changed

- `packages/afk/src/commands/supervise.ts`
- `packages/afk/src/core/supervisor.ts`
- `packages/afk/src/runtime/gh.ts`
- `packages/afk/src/runtime/proc-tree.ts`
- `packages/afk/src/runtime/supervisor-fs.ts`
- `packages/afk/tests/proc-tree.test.ts`
- `packages/afk/tests/supervisor.test.ts`
- `plugins/dev/skills/engineering/afk/bin/afk.mjs`

