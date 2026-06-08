---
title: Add Evidence inbox YAML review CLI
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-551]
pr: 551
merge_sha: b21db7728b3734231b1a8f77cc13ae456019aa6a
---

# Add Evidence inbox YAML review CLI

- **PR:** [#551](https://github.com/reddb-io/red-skills/pull/551)
- **Author:** @filipeforattini
- **Merge SHA:** `b21db7728b3734231b1a8f77cc13ae456019aa6a`
- **Format:** merged pull request

## Summary

## Summary
- add the experimental memory.evidence_card.experimental.v0 YAML Evidence card contract and inbox persistence
- add memory evidence create/list/show/approve/reject without graph promotion or proposal application
- cover YAML round-trip, validation failures, redaction before persistence, Evidence review, and existing JSON inbox behavior

## Validation
- pnpm --dir src/apps/memory typecheck
- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/evidence-card.test.ts tests/inbox-cli.test.ts
- pnpm --dir src/apps/memory exec vitest run tests/suite-split.test.ts

Closes #545

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/551"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783480244&installation_id=129708444&pr_number=551&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F551&signature=f21e1f857383e2c4466660c01d93e66414226e99d9912d0dd698c9deafcaa595"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Evidence card system: create, list, show, approve, reject, review states, privacy/redaction, deterministic IDs, routing/proposal links, CLI support, and inbox persistence
  * Brain CLI: init, status, capture, search, think, get, link, backlinks, hook for local artifact storage
  * Skill curation CLI: list curatable candidates, archive and restore skills with manifest verification

* **Documentation**
  * Expanded glossary detailing evidence card contract, refinement workflow, routing, safety controls, and relationships/invariants

* **Tests**
  * Integration tests covering evidence card lifecycle, CLI flows, validation, redaction, and persistence
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore: save local work
- Add evidence card inbox review CLI
- Merge remote-tracking branch 'origin/main' into afk/wVLE2/545-evidenc…
- chore: record memory context ingest
- Address evidence review feedback

## Files changed

- `.red/contexts/memory/CONTEXT.md`
- `plugins/brain/dist-bundle/brain-cli.mjs`
- `plugins/brain/dist-bundle/brain-mcp.mjs`
- `src/apps/memory/dist-bundle/memory-cli.mjs`
- `src/apps/memory/dist-bundle/memory-mcp.mjs`
- `src/apps/memory/dist-bundle/red-curate-skill.mjs`
- `src/apps/memory/memory-runtime-manifest.json`
- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/evidence-card.ts`
- `src/apps/memory/tests/evidence-card.test.ts`
- `src/apps/memory/vitest.suites.ts`

