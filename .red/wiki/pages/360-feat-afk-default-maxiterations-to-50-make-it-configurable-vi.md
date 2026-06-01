---
title: feat(afk): default maxIterations to 50 + make it configurable via .red/config.yaml
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-360]
pr: 360
merge_sha: 05d262d161b0e6d374c0a321f65b03fb37fcae20
---

# feat(afk): default maxIterations to 50 + make it configurable via .red/config.yaml

- **PR:** [#360](https://github.com/reddb-io/red-skills/pull/360)
- **Author:** @filipeforattini
- **Merge SHA:** `05d262d161b0e6d374c0a321f65b03fb37fcae20`
- **Format:** merged pull request

## Summary

## What

Two changes to the sandcastle re-invocation ceiling (issue #322's safety cap):

1. **Default 25 → 50.** Headroom for a thorough agent that keeps refining/testing across many internal iterations before emitting `<promise>DONE</promise>`. The completion sentinel stays the real terminator, so a normal issue still finishes in 1–3 iterations — this is purely the cap (each iteration is itself bounded by `idleTimeoutSeconds`).
2. **Configurable via `.red/config.yaml`** under `afk.max_iterations`, mirroring the existing `afk.sandbox`/`afk.model`/`afk.default_runner` keys.

## Precedence

`RED_AFK_MAX_ITERATIONS` env > `afk.max_iterations` config > **DEFAULT (50)** — resolved in `resolveRunSettings` and threaded `RunSettings → buildProcessDeps → makeRunAgent`. `parseMaxIterations` rejects a non-numeric / zero / negative value from **either** source, so a typo can never disable the cap or pin the agent to 1 iteration.

```yaml
afk:
  max_iterations: 50
```

## Validation

780 dev tests green (5 new `wire.test.ts` cases: config→50, env override→80, invalid-env→config fallback, invalid-config→undefined/default, no-source→undefined). `parseMaxIterations` is statically imported into `wire.ts` (pure — no eager sandcastle pull; providers stay lazy via `defaultSandcastleDeps`). New *Configuration* section in SKILL.md documents the scalar `afk.*` keys. `bin/afk.mjs` rebuilt.

Refs #322, #284.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/360"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782874209&installation_id=129708444&pr_number=360&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F360&signature=1a4b6427bbac86ba8d7c59f5992a449e450055c127309e6ded2170c5695be7e0"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): default maxIterations to 50 and make it configurable via .…

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/core/execution.ts`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/tests/wire.test.ts`

