---
title: fix(afk): malformed or block-sequence config never silently disarms guards
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-661]
pr: 661
merge_sha: 2560a18ed0d947651360e1310c06ed82d06d2398
---

# fix(afk): malformed or block-sequence config never silently disarms guards

- **PR:** [#661](https://github.com/reddb-io/red-skills/pull/661)
- **Author:** @filipeforattini
- **Merge SHA:** `2560a18ed0d947651360e1310c06ed82d06d2398`
- **Format:** merged pull request

## Summary

## Summary

- Strip inline comments that follow a closing quote on both mapping values (`key: "v" # note`) and block-sequence items (`- "cmd" # note`) **before** quote-validation runs, so a valid quoted scalar with a trailing comment no longer throws `MalformedConfigError`
- Because the parse error is silenced, `loadConfig` no longer falls back to all-defaults, so `dev.lock-primary-branch: true` (and all other guard flags) survive the presence of a block-sequence sibling value (e.g. `afk.backpressure`)

## Changes

- `src/apps/dev/src/core/config.ts`: Added post-closing-quote comment stripping in two branches of `parseConfigYaml` — the block-sequence item branch (lines 158–165) and the mapping-value branch (lines 188–195)
- `src/apps/dev/tests/config.test.ts`: Three new tests covering the inline-comment scalar (double-quoted and single-quoted) and the block-sequence + guard end-to-end case

## Test plan

- [x] `vitest run tests/config.test.ts` — 40/40 pass
- [x] "inline comment after double-quoted scalar parses without throwing"
- [x] "inline comment after single-quoted scalar parses without throwing"
- [x] "block-sequence config does not disable the primary-branch guard"
- [x] "strips inline comment after closing quote on a sequence item"

Closes #582

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/661"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783698714&installation_id=129708444&pr_number=661&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F661&signature=106852f04c8982468ad1fb372ca7d787dda48d9fd143aac9ee4a44e48fd7889f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Fixed YAML configuration parsing to properly strip inline comments that appear after quoted scalar values. Users can now safely add comments on the same line as quoted configuration values without the comment text being included in the parsed value.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): strip inline comments after closing quotes in config parser

## Files changed

- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/tests/config.test.ts`

