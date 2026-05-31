---
title: fix(afk): harden sandcastle integration (pre-mortem J/E/D/F/G/H)
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-328]
pr: 328
merge_sha: e20c80f3e46276e1811f12bf816a56b1e0e3776c
---

# fix(afk): harden sandcastle integration (pre-mortem J/E/D/F/G/H)

- **PR:** [#328](https://github.com/reddb-io/red-skills/pull/328)
- **Author:** @filipeforattini
- **Merge SHA:** `e20c80f3e46276e1811f12bf816a56b1e0e3776c`
- **Format:** merged pull request

## Summary

Pre-mortem fixes: J pre_worktree env now reaches the agent (cargo/gradle slot isolation), E missing-branch feedback bypass closed, D per-provider effort validation, F continuous-push docker warn, G RED_AFK_IDLE_TIMEOUT_S, H recursive exhaustion detection. 728 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/328"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782860644&installation_id=129708444&pr_number=328&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F328&signature=4415d13f118479fd944a8fa152bfe4d3caaedc615ba3f5a3004f5d971bb0d0d2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): harden the sandcastle integration (pre-mortem fixes J/E/D/F…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/execution.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/runtime/git.ts`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/tests/execution.test.ts`
- `src/domains/dev/tests/process-issue.test.ts`
- `src/domains/dev/tests/runtime-git-branch.test.ts`

