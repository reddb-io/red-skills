---
title: feat(afk): Blacksmith runner for rs-* + Closes #N auto-close on AFK PRs
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-726]
pr: 726
merge_sha: 6cd3665540ff926708527a18f971b4abe7a712bd
---

# feat(afk): Blacksmith runner for rs-* + Closes #N auto-close on AFK PRs

- **PR:** [#726](https://github.com/reddb-io/red-skills/pull/726)
- **Author:** @filipeforattini
- **Merge SHA:** `6cd3665540ff926708527a18f971b4abe7a712bd`
- **Format:** merged pull request

## Summary

## What

Two AFK Actions-lane improvements, packaged together.

### 1. Run the lane on Blacksmith
- The reusable `red-afk-attempt.yml` gains a **`runs_on`** input (default `ubuntu-latest`, so **adopters are unchanged**); `runs-on:` resolves `${{ inputs.runs_on || 'ubuntu-latest' }}`.
- red-skills' own `rs-afk-attempt.yml` caller passes **`runs_on: blacksmith-2vcpu-ubuntu-2404`** — the **smallest** Blacksmith tier (there is no "nano"; 2 vCPU is the floor). The Blacksmith GitHub App is installed on the org.

### 2. Auto-close the issue when the PR merges (issue ↔ PR link)
- The AFK PR body (`merge.ts` `landPr`) now carries **`Closes #N`**, so a human-merged GHA-lane PR **auto-closes the linked issue** natively. `/ship` already did this; the local admin-merge path closes the issue itself — both idempotent.

### Also
- `MiniMax-M2` → `M3` in the reusable + composite-action input descriptions.
- Docs in `actions-lane.md`: `runs_on` input row, a "Runner host — GitHub-hosted or Blacksmith" section, and an "Issue ↔ PR link (auto-close on merge)" section.

## Notes
- No test asserts the AFK PR body, so the `Closes #N` append is safe; the CI `test` job covers `merge.ts`.
- Both workflow files YAML-validated.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/726"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783822277&installation_id=129708444&pr_number=726&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F726&signature=37d807a948f8b96876321f4a3952cc5a88846227d37e03b118b07ce82731b015"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added support for custom runner selection via new `runs_on` parameter in workflows.
  * PRs now automatically close linked issues when merged.

* **Documentation**
  * Updated workflow and action documentation to reflect model references and runner configuration options.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): Blacksmith runner for rs-* + Closes #N auto-close on AFK PRs

## Files changed

- `.github/actions/afk-attempt/action.yml`
- `.github/workflows/red-afk-attempt.yml`
- `.github/workflows/rs-afk-attempt.yml`
- `apps/dev/src/core/merge.ts`
- `plugins/dev/skills/engineering/afk/actions-lane.md`

