---
title: feat(afk): enable the GHA AFK lane on red-skills (submodule checkout + rs-* self-caller)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-722]
pr: 722
merge_sha: 35b457ae422b7f547bea286590406cede5a1e28b
---

# feat(afk): enable the GHA AFK lane on red-skills (submodule checkout + rs-* self-caller)

- **PR:** [#722](https://github.com/reddb-io/red-skills/pull/722)
- **Author:** @filipeforattini
- **Merge SHA:** `35b457ae422b7f547bea286590406cede5a1e28b`
- **Format:** merged pull request

## Summary

## Goal
Make red-skills run its **own** AFK lane from GitHub Actions — the first step toward 'GHA coding for us'. Two changes:

### 1. Recursive submodule checkout in the reusable
`red-afk-attempt.yml` now checks out with **`submodules: recursive`**. red-skills' `apps/dev` imports `@reddb-io/red-castle` (a `workspace:*` git submodule, ADR 0061), so the feedback gate's `pnpm` build needs it. **No-op for adopter repos** (no submodule). 

**No deploy key / PAT needed** — `packages/red-castle` is a **public** repo (verified: an unauthenticated `git ls-remote` reaches it), so the default `GITHUB_TOKEN` clones it; `actions/checkout` rewrites the `git@github.com:` submodule URL to token-https automatically.

### 2. `rs-afk-attempt.yml` — red-skills' own caller (the `rs-*` convention)
Naming convention this PR introduces: our **reusable** workflows ship as **`red-*`** (`red-afk-attempt.yml`); a workflow **INSTALLED into a target repo** to drive the lane is **`rs-*`** ('RedSkills-installed-here'). red-skills self-hosting is `rs-*` too.

- Calls the **local** reusable (`./.github/workflows/red-afk-attempt.yml`).
- **Dispatch** (manual issue number) **+ auto-trigger** on the `ready-for-agent` label.
- opencode + **`minimax/MiniMax-M3`** via the org **`MINIMAX_API_KEY`** secret.
- Trust gate limited to `filipeforattini`.

Runner stays `ubuntu-latest`; the **Blacksmith** swap (`runs-on: blacksmith-2vcpu-ubuntu-2404`) is a one-line follow-up once the Blacksmith GitHub App is installed on the org.

## Follow-up (separate PR)
The full `red-* → rs-*` convention in the skills: `/setup-red-skills` installs adopter workflows renamed to `rs-*` (asking which + configs), `/doctor` audits `rs-*` adoption, `WORKFLOWS.md` documents the split.

## Test plan
After merge: `gh workflow run rs-afk-attempt.yml -f issue_number=<N>` on a small issue → watch opencode code it + open a PR in the cloud (clean, submodule-provisioned env — none of the local-worktree gate holes).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/722"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783818324&installation_id=129708444&pr_number=722&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F722&signature=5757365bd094987fb9f19103c4de0ba337579520f5283b352e21ec7e77d70caf"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): enable the GHA AFK lane on red-skills (submodule checkout …

## Files changed

- `.github/workflows/red-afk-attempt.yml`
- `.github/workflows/rs-afk-attempt.yml`

