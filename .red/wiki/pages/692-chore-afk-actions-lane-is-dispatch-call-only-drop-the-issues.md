---
title: chore(afk): Actions lane is dispatch/call-only — drop the issues auto-trigger until secrets are set
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-692]
pr: 692
merge_sha: 01006baecd13440f45b504a35921ee7e9b9ba5c9
---

# chore(afk): Actions lane is dispatch/call-only — drop the issues auto-trigger until secrets are set

- **PR:** [#692](https://github.com/reddb-io/red-skills/pull/692)
- **Author:** @filipeforattini
- **Merge SHA:** `01006baecd13440f45b504a35921ee7e9b9ba5c9`
- **Format:** merged pull request

## Summary

Quiets the failing `red-afk-attempt` CI runs. The lane fired on every `ready-for-agent` issue (`issues: [labeled, opened]`) and failed at *Run the AFK attempt* because the repo has **no auth secrets** configured — noise, not a build defect.

- Remove the `issues:` auto-trigger; `on:` is now **`workflow_call` + `workflow_dispatch` only**.
- Simplify the job `if:` to dispatch/call (the two `issues`-event branches removed).
- Header + job comments document how to **restore auto-firing** (re-add the trigger + the two `if:` branches) once MINIMAX/OPENAI/OPENROUTER secrets are set.

No runtime/contract change. YAML validated.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/692"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783748559&installation_id=129708444&pr_number=692&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F692&signature=6a5fa16b89f7eb48b48e4edff6c638fa0b01bd251b7f52e86aeff88ac1efd053"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Updated GitHub Actions workflow configuration, removing automatic event triggering.

* **Documentation**
  * Added inline documentation clarifying workflow trigger behavior and configuration steps for future restoration.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(afk): Actions lane is dispatch/call-only — drop the issues auto…

## Files changed

- `.github/workflows/red-afk-attempt.yml`

