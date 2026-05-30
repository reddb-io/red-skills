---
title: merge: #227 AFK: make <promise> sentinel the canonical attempt exit signal
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-265]
pr: 265
merge_sha: 9e2ef6a4b314e155183c961364d93dbd90ed0c6b
---

# merge: #227 AFK: make <promise> sentinel the canonical attempt exit signal

- **PR:** [#265](https://github.com/reddb-io/red-skills/pull/265)
- **Author:** @filipeforattini
- **Merge SHA:** `9e2ef6a4b314e155183c961364d93dbd90ed0c6b`
- **Format:** merged pull request

## Summary

Automated AFK landing for #227. Per-attempt history lives in the issue Envelopes, the JSONL logs, and the `afk-attempts/*` snapshot branches.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/265"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782713384&installation_id=129708444&pr_number=265&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F265&signature=fef98e93b238bfd083beac8e3f3d6f51970d7124d648e1d56b5a701b14338b8e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): add lib/attempt-reader.sh — canonical attempt-exit reader
- feat(afk): trust the <promise> sentinel as the attempt-exit signal
- test(afk): cover attempt-reader detection, tear-down, watch + wiring
- test(afk): assert post_attempt carries result.outcome (ADR 0028)
- docs(afk): document the attempt-exit reader + result.outcome (ADR 0028)

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/attempt-reader.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/attempt-reader.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-attempt-rename.test.sh`

