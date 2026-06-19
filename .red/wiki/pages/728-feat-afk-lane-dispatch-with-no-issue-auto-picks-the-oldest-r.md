---
title: feat(afk-lane): dispatch with no issue auto-picks the oldest ready-for-agent
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-728]
pr: 728
merge_sha: bf8f45aafa9c79b7754a814432b50966f4c404a0
---

# feat(afk-lane): dispatch with no issue auto-picks the oldest ready-for-agent

- **PR:** [#728](https://github.com/reddb-io/red-skills/pull/728)
- **Author:** @filipeforattini
- **Merge SHA:** `bf8f45aafa9c79b7754a814432b50966f4c404a0`
- **Format:** merged pull request

## Summary

## What

You can now **dispatch the AFK lane with no issue number** — hit *Run workflow*, leave `issue_number` empty, and it grabs the **oldest open `ready-for-agent` issue** (the queue head) and runs it. If the queue is empty, the run is a **clean no-op**.

## How

The reusable's "Resolve the issue number" step (github-script) now, when `issue_number` is empty on `workflow_dispatch` / `workflow_call`, queries `issues.listForRepo({ labels: 'ready-for-agent', state: 'open', sort: 'created', direction: 'asc' })`, skips PRs, and takes the first. No match → empty output + the trust gate and downstream steps skip (`if: steps.resolve.outputs.number != ''`).

## Changes
- **`reusable-afk-attempt.yml`** — `issue_number` optional on dispatch; auto-pick logic; trust gate gated on a non-empty resolved number.
- **`red-skills-afk-attempt.yml`** (our caller) + **example caller** — dispatch `issue_number` now optional (empty = auto-pick).
- **`actions-lane.md`** — documented on the dispatch trigger + the Inputs row.

## Notes
- Workflow-only; no runtime change.
- The trust gate still runs on the auto-picked issue (author from the issue, label-actor = the dispatcher).
- `#622` (atomic server-side claim) will later prevent racing a concurrent local fleet; until then the runtime's own claim handles dedup.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/728"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783823896&installation_id=129708444&pr_number=728&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F728&signature=4340c8ee1f5f151e9a3e548d533d54e31d37037874cedc28fe786a92adbc9305"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Workflows now support making the issue number input optional, with smart auto-selection of the oldest open ready-for-agent issue when left empty.
  * Improved handling when no suitable issue is available, resulting in clean no-op behavior.

* **Documentation**
  * Updated workflow documentation and examples to clarify the new auto-selection behavior and optional input requirements.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk-lane): dispatch with no issue auto-picks the oldest ready-fo…

## Files changed

- `.github/workflows/red-skills-afk-attempt.yml`
- `.github/workflows/reusable-afk-attempt.yml`
- `plugins/dev/skills/engineering/afk/actions-lane.md`
- `plugins/dev/skills/engineering/afk/examples/red-skills-afk-attempt.yml`

