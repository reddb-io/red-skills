---
title: fix(afk): GHA trust gate resolves issue author on dispatch + unpin model from config
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-723]
pr: 723
merge_sha: 34d79c58b79f64f1e37b7c65d65ad114a93ff7cf
---

# fix(afk): GHA trust gate resolves issue author on dispatch + unpin model from config

- **PR:** [#723](https://github.com/reddb-io/red-skills/pull/723)
- **Author:** @filipeforattini
- **Merge SHA:** `34d79c58b79f64f1e37b7c65d65ad114a93ff7cf`
- **Format:** merged pull request

## Summary

Two follow-ups from the first live GHA run of the AFK lane (#722):

## 1. Trust gate failed on the dispatch path
A `workflow_dispatch` run failed the trust gate with **`author=undefined`** (and couldn't post the refusal comment): the gate read the author from `context.payload.issue`, which exists **only for the `issues` event**. On `workflow_dispatch`/`workflow_call` the issue arrives as an input — no `payload.issue`.

Fix: when the event is not `issues`, **fetch the issue by its resolved number** (`steps.resolve.outputs.number` → `ISSUE_NUMBER` env) to read the author; the refusal comment uses the same number. The `issues` path is unchanged.

## 2. Unpin the model from `.red/config.yaml`
`rs-afk-attempt.yml` already passes `model: minimax/MiniMax-M3`. Dropped the duplicate `plugins.dev.afk.models.opencode.base` pin so the **workflow is the single source of truth** for the cloud runner's model (kept `lock.primary-branch`).

After merge: re-dispatch `rs-afk-attempt.yml` on #585 → the gate should pass and opencode should code + open a PR.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/723"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783818725&installation_id=129708444&pr_number=723&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F723&signature=912bec1caf0ef7348a2c6d55967c1cc3cc47d8593377baea6989158f40baadd3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved reliability of automated workflow logic for correctly identifying issue authors and actors across different trigger mechanisms.

* **Chores**
  * Refactored configuration to simplify model selection management, now controlled via workflow environment variables rather than inline configuration.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): trust gate resolves the issue author on the dispatch/call path
- chore(afk): unpin the opencode model from .red/config.yaml (the workf…

## Files changed

- `.github/workflows/red-afk-attempt.yml`
- `.red/config.yaml`

