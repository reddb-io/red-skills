---
title: feat(afk): typed blocked:<reason> labels (descriptive, auto-classified)
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-293]
pr: 293
merge_sha: ead57f88e2d9ed5c4a918c28f9f6691cc91b0643
---

# feat(afk): typed blocked:<reason> labels (descriptive, auto-classified)

- **PR:** [#293](https://github.com/reddb-io/red-skills/pull/293)
- **Author:** @filipeforattini
- **Merge SHA:** `ead57f88e2d9ed5c4a918c28f9f6691cc91b0643`
- **Format:** merged pull request

## Summary

Stops flattening every failure to one `blocked`: tags the issue with the matching blocked:<reason> derived from the ProcessOutcome the runtime already computes (quota/merge-conflict/spec/validation/crashed/policy/stalled/infra). Additive — routing unchanged; auto-recovery deferred. 666 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/293"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782785603&installation_id=129708444&pr_number=293&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F293&signature=93b3fac84939382aa01b04c44200f76cb47450dfd011e758114781f981aba6a0"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): typed blocked:<reason> labels — descriptive, auto-classifi…

## Files changed

- `.red/agents/triage-labels.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/commands/supervise.ts`
- `src/domains/dev/src/core/envelope-emit.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/core/supervisor.ts`
- `src/domains/dev/src/runtime/gh.ts`
- `src/domains/dev/tests/envelope-emit.test.ts`
- `src/domains/dev/tests/process-issue.test.ts`
- `src/domains/dev/tests/supervisor.test.ts`

