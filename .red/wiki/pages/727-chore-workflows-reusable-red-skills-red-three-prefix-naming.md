---
title: chore(workflows): reusable-* / red-skills-* / red-* three-prefix naming scheme
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-727]
pr: 727
merge_sha: b0b20ff278740e586b0c4316c02d702e706797f0
---

# chore(workflows): reusable-* / red-skills-* / red-* three-prefix naming scheme

> **Superseded by [ADR 0067](../../adr/0067-workflow-naming-three-prefix-rs-caller.md).**
> The caller prefix `red-skills-*` was later renamed to **`rs-*`** (caller =
> instantiation of a reusable, one per reusable adopted), and copy-installables
> (e.g. needs-triage) now keep their `red-*` name on install. This page is kept
> as the dated record of the original scheme.

- **PR:** [#727](https://github.com/reddb-io/red-skills/pull/727)
- **Author:** @filipeforattini
- **Merge SHA:** `b0b20ff278740e586b0c4316c02d702e706797f0`
- **Format:** merged pull request

## Summary

## What

Replaces the previous `red-*` (source) / `rs-*` (installed) workflow-naming convention with **three role-based prefixes**:

| Prefix | Role |
|---|---|
| **`reusable-*`** | reusable (`workflow_call`) workflows — called by ref, **never copied** |
| **`red-skills-*`** | any workflow **installed into an adopter repo** (the caller + plain installables like needs-triage) |
| **`red-*`** | red-skills' **own** workflows that never leave this repo (internal CI + the *source* of plain installables) |

## Renames
- `.github/workflows/red-afk-attempt.yml` → **`reusable-afk-attempt.yml`** (the reusable)
- `.github/workflows/rs-afk-attempt.yml` → **`red-skills-afk-attempt.yml`** (our self-adoption caller)
- `examples/red-afk-attempt-caller.yml` → **`examples/red-skills-afk-attempt.yml`**

## Every reference updated
Public `uses:` ref (`reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@v1`), workflow `name:` fields, header comments, **WORKFLOWS.md** (full convention rewrite), **setup-red-skills** Section D + install steps, **doctor** check 10 + Fix-home/Apply tables, **actions-lane.md**, the **dev glossary**, **ADR 0062**, **CHANGES.md**, `.red/config.yaml`.

## Notes
- No external adopters yet, so renaming the public reusable ref is safe (we're the only caller, via the local `./` path).
- `red-issues-needs-triage.yml` and internal CI keep `red-*` (per the agreed scheme); the installed copy of needs-triage becomes `red-skills-issues-needs-triage.yml`.
- ADR 0062 + glossary are drift-guard-watched → commit carries `Memory-NoIngest:` (mechanical rename, no new decision).
- Both renamed workflows YAML-validated.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/727"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783823187&installation_id=129708444&pr_number=727&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F727&signature=583249e93ea51cae653e3f5e196ec68c46d18367d08772069a924536944268ea"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **Chores**
  * Standardized GitHub Actions workflow naming conventions across internal deployment workflows for improved consistency and clarity.

* **Documentation**
  * Updated setup guides, skill documentation, and AFK lane documentation to reflect new workflow naming conventions and installation procedures.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(workflows): rename to the reusable-*/red-skills-*/red-* three-p…

## Files changed

- `.github/workflows/red-skills-afk-attempt.yml`
- `.github/workflows/reusable-afk-attempt.yml`
- `.red/adr/0062-afk-actions-lane-is-a-composite-action.md`
- `.red/config.yaml`
- `.red/contexts/dev/CONTEXT.md`
- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/actions-lane.md`
- `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-action.yml`
- `plugins/dev/skills/engineering/afk/examples/red-skills-afk-attempt.yml`
- `plugins/dev/skills/engineering/doctor/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/WORKFLOWS.md`

