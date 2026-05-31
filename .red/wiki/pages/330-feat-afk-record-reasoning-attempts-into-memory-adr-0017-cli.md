---
title: feat(afk): record reasoning attempts into memory (ADR 0017), CLI-to-CLI direct
type: source
tags: [pr, merged]
created: 2026-05-31
updated: 2026-05-31
sources: [pr-330]
pr: 330
merge_sha: d838adab8d84cd24f172d334b5b95f36954410ac
---

# feat(afk): record reasoning attempts into memory (ADR 0017), CLI-to-CLI direct

- **PR:** [#330](https://github.com/reddb-io/red-skills/pull/330)
- **Author:** @filipeforattini
- **Merge SHA:** `d838adab8d84cd24f172d334b5b95f36954410ac`
- **Format:** merged pull request

## Summary

Restores the AFK→memory reasoning-attempt recording (ADR 0017) dropped in the port. Writes validation.jsonl + records an attempt node after each terminal envelope, best-effort/gated. The dev CLI calls the memory CLI DIRECTLY (no bash→memory-bridge.sh hop) — the two domain CLIs talk CLI-to-CLI; the .sh stays only for the agent-skill recall. 757 tests. [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/330"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782862385&installation_id=129708444&pr_number=330&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F330&signature=e845b2f764e80ba823cb7de11a4c03f78947476754ec37cc0796cdc42ea3a9ef"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): record reasoning attempts into memory (ADR 0017) — dev CLI…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/attempt-record.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/runtime/fs.ts`
- `src/domains/dev/tests/attempt-record.test.ts`
- `src/domains/dev/tests/process-issue.test.ts`

