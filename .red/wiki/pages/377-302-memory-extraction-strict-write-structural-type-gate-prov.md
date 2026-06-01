---
title: #302 Memory extraction: strict-write structural-type gate (provider path)
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-377]
pr: 377
merge_sha: 7f9f6b8c840a4b20418d1ec79bedb6ae88b1bf61
---

# #302 Memory extraction: strict-write structural-type gate (provider path)

- **PR:** [#377](https://github.com/reddb-io/red-skills/pull/377)
- **Author:** @filipeforattini
- **Merge SHA:** `7f9f6b8c840a4b20418d1ec79bedb6ae88b1bf61`
- **Format:** merged pull request

## Summary

Lands the verified work from AFK worker wYQCM for #302. Implementation committed as b4a5310 on the worker branch: strict-write structural-type gate on the provider path, open engineering-code axis (no rejection). Full memory suite 675/675 green, typecheck clean, merge-tree conflict-free against current main. AFK kept re-invoking without emitting the DONE sentinel (the issue's chronic no-sentinel pattern, 30+ attempts), so landing manually via admin-merge. Closes #302.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/377"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782937595&installation_id=129708444&pr_number=377&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F377&signature=5e5dae978321ba415e2bb63700328789c211897b1972ae44ffc675d4bdc5490b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(memory): strict-write structural-type gate on the INFERRED extra…

## Files changed

- `src/apps/memory/src/engine.ts`
- `src/apps/memory/src/extract-conversation.ts`
- `src/apps/memory/src/schema.ts`
- `src/apps/memory/tests/engine.test.ts`
- `src/apps/memory/tests/extract-conversation.test.ts`

