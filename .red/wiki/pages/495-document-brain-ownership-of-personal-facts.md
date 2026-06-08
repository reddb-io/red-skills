---
title: Document Brain ownership of personal facts
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-495]
pr: 495
merge_sha: 0eb7c3562106f384c3e6a059ef2baadb943d95b1
---

# Document Brain ownership of personal facts

- **PR:** [#495](https://github.com/reddb-io/red-skills/pull/495)
- **Author:** @filipeforattini
- **Merge SHA:** `0eb7c3562106f384c3e6a059ef2baadb943d95b1`
- **Format:** merged pull request

## Summary

Closes #488.

## Summary
- document that Personal facts belong in Brain, not Memory, across top-level, Brain, Memory, and context routing docs
- tighten Memory store/extract guidance toward operational evidence only
- update Memory runtime routing guide and extraction prompt for Personal fact boundaries
- add doc-contract and routing/extraction tests, plus updated routing viewer snapshot

## Validation
- pnpm --dir src/apps/dev exec vitest run tests/memory-brain-boundary-docs.test.ts
- pnpm --dir src/apps/memory exec vitest run tests/extract-conversation.test.ts tests/viewer-rendering.test.ts
- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/routing-guide.test.ts
- pnpm --dir src/apps/dev exec tsc -p tsconfig.json --noEmit
- pnpm --dir src/apps/memory exec tsc -p tsconfig.json --noEmit

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/495"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783250937&installation_id=129708444&pr_number=495&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F495&signature=4255a48f83adf5d344e512896b9b910dfda90023cc53711eba35f17d14576d1d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Clarified the distinction between Memory plugin (operational facts) and Brain plugin (personal/biographical details and human-facing context)
  * Updated documentation and skill guides to direct personal facts, identity context, and durable preferences to Brain instead of Memory

* **Tests**
  * Added validation tests to ensure documentation consistency across Memory/Brain boundary

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs: route personal facts to Brain

## Files changed

- `README.md`
- `plugins/brain/README.md`
- `plugins/brain/skills/core/README.md`
- `plugins/brain/skills/core/capture/SKILL.md`
- `plugins/dev/skills/engineering/context/SKILL.md`
- `plugins/memory/README.md`
- `plugins/memory/skills/core/extract/SKILL.md`
- `plugins/memory/skills/core/store/SKILL.md`
- `src/apps/dev/tests/memory-brain-boundary-docs.test.ts`
- `src/apps/memory/src/extract-conversation.ts`
- `src/apps/memory/src/routing-guide.ts`
- `src/apps/memory/tests/__snapshots__/viewer-rendering.test.ts.snap`
- `src/apps/memory/tests/extract-conversation.test.ts`
- `src/apps/memory/tests/routing-guide.test.ts`

