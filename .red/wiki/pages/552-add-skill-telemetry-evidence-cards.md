---
title: Add Skill telemetry Evidence cards
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-552]
pr: 552
merge_sha: 8f4d9653fcabd8e83bfba2d589612ff083061e18
---

# Add Skill telemetry Evidence cards

- **PR:** [#552](https://github.com/reddb-io/red-skills/pull/552)
- **Author:** @filipeforattini
- **Merge SHA:** `8f4d9653fcabd8e83bfba2d589612ff083061e18`
- **Format:** merged pull request

## Summary

## Summary
- add linked YAML Evidence cards for failing Skill telemetry in memory improve-skills
- preserve the existing proposals JSON shape while adding an evidenceCards sibling for review tooling
- cite skill-event source refs instead of dumping raw telemetry payloads, with route/blast-radius/judge/privacy/proposal traceability blocks

## Validation
- pnpm --dir src/apps/memory typecheck
- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/improve-skills.test.ts

Closes #546

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/552"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783482824&installation_id=129708444&pr_number=552&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F552&signature=befe3fee42a32738abaab16ff0c0a4edc2c974c227cc43633212bb7f607880fa"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## New Features

* New Brain CLI providing artifact capture, search, content linking, and backlink discovery
* Memory skill curation tool with check, list, archive, and restore commands
* Evidence cards automatically generated with skill improvement proposals
* Extended skill event summary with event tracking identifiers and file paths

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore: save local work
- Add skill telemetry evidence cards
- Merge origin/main into skill telemetry evidence cards

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/src/skill-events.ts`
- `src/apps/memory/tests/improve-skills.test.ts`

