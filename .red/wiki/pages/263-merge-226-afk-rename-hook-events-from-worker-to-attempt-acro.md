---
title: merge: #226 AFK: rename hook events from worker/* to attempt/* across merged code
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-263]
pr: 263
merge_sha: 7b4608b03faa2b5e58777a8374ec87cf95350f08
---

# merge: #226 AFK: rename hook events from worker/* to attempt/* across merged code

- **PR:** [#263](https://github.com/reddb-io/red-skills/pull/263)
- **Author:** @filipeforattini
- **Merge SHA:** `7b4608b03faa2b5e58777a8374ec87cf95350f08`
- **Format:** merged pull request

## Summary

Automated AFK landing for #226. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/263"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782711702&installation_id=129708444&pr_number=263&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F263&signature=d7208a183ae55778f00547389df436362db615a3e6ea89c1da04ea7c067a464b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(afk): rename attempt-level hook events in dispatcher
- feat(afk): translate deprecated *_worker hook names with one warning
- feat(afk): fire pre/post_attempt per runner invocation with attempt_n
- refactor(afk): rename heartbeat default to post-attempt
- refactor(afk): rename envelope default to post-attempt
- docs(afk): document attempt-level hooks, attempt_n, and back-compat
- test(afk): assert renamed canonical set + alias resolution
- test(afk): default-kind probe iterates post_attempt
- test(afk): rename on_worker_error→on_attempt_error anchors; fix row s…
- test(afk): rewrite pre_worktree/pre_attempt lifecycle test
- test(afk): rewrite post_attempt/on_attempt_error lifecycle test
- test(afk): cover attempt_n, per-invocation cadence, and back-compat

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/defaults/envelope-post-attempt.sh`
- `plugins/dev/skills/engineering/afk/defaults/heartbeat-post-attempt.sh`
- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/hook-dispatcher.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/hook-dispatcher.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-attempt-rename.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks-executed.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-on-session-error.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-post-attempt-on-error.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-worktree-pre-attempt.test.sh`

