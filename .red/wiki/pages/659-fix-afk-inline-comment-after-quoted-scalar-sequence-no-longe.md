---
title: fix(afk): inline comment after quoted scalar/sequence no longer disarms config guards
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-659]
pr: 659
merge_sha: 5b86aff06db39b57a925328478a577a57c827229
---

# fix(afk): inline comment after quoted scalar/sequence no longer disarms config guards

- **PR:** [#659](https://github.com/reddb-io/red-skills/pull/659)
- **Author:** @filipeforattini
- **Merge SHA:** `5b86aff06db39b57a925328478a577a57c827229`
- **Format:** merged pull request

## Summary

## Summary

- Quoted scalar with trailing inline comment (`key: "value" # note`) now parses correctly instead of throwing `MalformedConfigError`
- Quoted block-sequence item with trailing inline comment (`- "cmd" # note`) also handled the same way
- Both cases previously caused `loadConfig` to revert ALL config to defaults, silently resetting `dev.lock-primary-branch` to `"false"` and disarming the primary-branch guard

## Root cause

`parseConfigYaml` skips comment stripping when it detects a quoted string on the line (to avoid misinterpreting a `#` inside a quoted value). But the quote-validation step that follows then sees the leftover comment text after the closing quote and throws `MalformedConfigError`.

## Fix

After extracting the raw scalar value or block-sequence item, detect the pattern `<closing-quote> <optional-whitespace> # <comment>` and trim the comment before the quote validation runs. Unclosed quotes still throw as before.

## Test plan

- [x] `parseConfigYaml` with `key: "v" # comment` → `{key: "v"}`, no throw
- [x] `parseConfigYaml` with `key: 'v' # comment` → `{key: "v"}`, no throw
- [x] `parseConfigYaml` with `- "cmd" # comment` → `{parent.0: "cmd"}`, no throw
- [x] `loadConfig` with block-sequence + `dev.lock-primary-branch: true` → guard reads as `"true"`
- [x] Full test suite: 1231 tests pass

Closes #582
Parent: #567

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/659"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783698156&installation_id=129708444&pr_number=659&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F659&signature=c698d4b2fedbb9f3f44138bfb9070ad3717cc38eea5a8466e202965958a0ad40"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): strip inline comments after closing quotes in config parser

## Files changed

- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/tests/config.test.ts`

