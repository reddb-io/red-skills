---
title: fix(afk): shell config reader skips block-sequence items and strips post-quote inline comments
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-663]
pr: 663
merge_sha: 0bf2497dca9e31530674aea0dc25af4262518403
---

# fix(afk): shell config reader skips block-sequence items and strips post-quote inline comments

- **PR:** [#663](https://github.com/reddb-io/red-skills/pull/663)
- **Author:** @filipeforattini
- **Merge SHA:** `0bf2497dca9e31530674aea0dc25af4262518403`
- **Format:** merged pull request

## Summary

## Summary

Closes #582. Two bugs in `plugins/dev/skills/misc/branch-lock/scripts/lib/dev-config.sh` silently disabled the primary-branch guard:

- **Block-sequence items caused early bailout**: Any line matching `- value` failed the mapping-key regex and triggered `return 1` immediately, so a config containing `afk.backpressure` items would disable the guard before the parser ever reached `dev.lock-primary-branch`.
- **Inline comments after quoted scalars were not stripped**: The early comment-strip pass skips lines containing quotes entirely, so `"true" # note` stayed as the raw value — `"true" # note" != "true"` → guard disabled.

The TypeScript fix (`config.ts`) was already committed in `df92d7af`. This PR fixes the shell reader to match.

**Changes:**
- `dev-config.sh`: skip nested block-sequence lines (bail only on top-level sequences, matching TS `MalformedConfigError` semantics); strip trailing `# comment` after a detected closing quote before the equality check.
- `dev-config.test.sh`: three new test cases — inline-comment quoted scalar, block-sequence as sibling of the dev key, and block-sequence before the dev key.

## Test plan

- [x] Shell tests: `bash plugins/dev/skills/misc/branch-lock/scripts/tests/dev-config.test.sh` — 9/9 passed
- [x] TypeScript tests: `vitest run tests/config.test.ts` — 40/40 passed (pre-existing TS fix)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/663"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783699243&installation_id=129708444&pr_number=663&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F663&signature=4a78176572fc9a3d7b957a69eb519ea74f700cf418e5a6ac445180ef75e99f70"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): strip inline comments after closing quotes in config parser
- fix(afk): shell config reader skips block-sequence items and strips p…

## Files changed

- `plugins/dev/skills/misc/branch-lock/scripts/lib/dev-config.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/tests/dev-config.test.sh`
- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/tests/config.test.ts`

