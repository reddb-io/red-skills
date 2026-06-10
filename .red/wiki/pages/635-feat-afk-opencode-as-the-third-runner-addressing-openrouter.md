---
title: feat(afk): OpenCode as the third runner, addressing OpenRouter (ADR 0059)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-635]
pr: 635
merge_sha: be3380516dcbe8f0c5fdf25211e511d7592d6ae4
---

# feat(afk): OpenCode as the third runner, addressing OpenRouter (ADR 0059)

- **PR:** [#635](https://github.com/reddb-io/red-skills/pull/635)
- **Author:** @filipeforattini
- **Merge SHA:** `be3380516dcbe8f0c5fdf25211e511d7592d6ae4`
- **Format:** merged pull request

## Summary

Resolves #626

## What

Adds OpenCode as the third AFK runner (ADR 0059, parent PRD #614):

- `runner-opencode.md` contract with exhaustion strings + tier table
- sandcastle provider through the existing `agentFor` seam; pure `buildAgent` is unit-testable
- Cascade accepts `opencode` only as an explicit pin (never auto-sniffed)
- Model tier config under `afk.models.opencode.*`

## Verification

- 1147/1147 tests pass
- typecheck clean
- E2E with real `OPENROUTER_API_KEY` deferred to CI Actions-lane slice (per acceptance)

Refs #626

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/635"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783661284&installation_id=129708444&pr_number=635&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F635&signature=3bfa7eadbeceac3660bdc4974a9400024e6e5868944c356a0849ced6c2c9e04d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): add opencode to the runner vocabulary
- feat(afk): wire opencode provider through a testable buildAgent seam
- feat(afk): add afk.models.opencode.* tier table and resolve it per ru…
- fix(afk): let an opencode pin flow to the spawn instead of coercing t…
- test(afk): assert opencode pins but is never auto-sniffed
- test(afk): cover buildAgent opencode mapping (slug, variant, env pass…
- test(afk): cover the opencode model-tier defaults and override
- docs(adr): index ADR 0059 under AFK execution & lifecycle
- docs(afk): surface opencode in the SKILL runner cascade and exhaustio…
- docs(afk): add the runner-opencode.md contract
- docs(adr): add ADR 0059 — OpenCode is the third AFK runner over OpenR…

## Files changed

- `.red/adr/0059-opencode-is-the-third-afk-runner-over-openrouter.md`
- `.red/adr/INDEX.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/runner-opencode.md`
- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/types/runner.ts`
- `src/apps/dev/tests/config.test.ts`
- `src/apps/dev/tests/execution.test.ts`
- `src/apps/dev/tests/runner-detection.test.ts`

