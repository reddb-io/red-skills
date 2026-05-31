---
title: feat(afk): bounded auto-recovery for recoverable blocks
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-294]
pr: 294
merge_sha: 0b4e51e5d880530bdbae9b6fddb5be7caac567b4
---

# feat(afk): bounded auto-recovery for recoverable blocks

- **PR:** [#294](https://github.com/reddb-io/red-skills/pull/294)
- **Author:** @filipeforattini
- **Merge SHA:** `0b4e51e5d880530bdbae9b6fddb5be7caac567b4`
- **Format:** merged pull request

## Summary

Recoverable failures (quota/merge-conflict/crashed/policy) retry up to a per-reason cap then escalate to ready-for-human; spec/validation always page. Self-heals transient hiccups without paging, bounded against runaway. Caps env-tunable. 688 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/294"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782787881&installation_id=129708444&pr_number=294&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F294&signature=2691b85ad46d561479a4dda3d8bd3391966aefa363b76bc3abcbf66d4a2be10a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): bounded auto-recovery — recoverable blocks retry, then esc…

## Files changed

- `.red/agents/triage-labels.md`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/core/recovery.ts`
- `src/domains/dev/tests/process-issue.test.ts`
- `src/domains/dev/tests/recovery.test.ts`

