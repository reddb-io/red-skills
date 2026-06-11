---
title: feat(setup): /setup-red-skills installs the autonomous AFK lane (opt-in) + workflow catalogue
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-680]
pr: 680
merge_sha: 1df770c6b0d0d75d9418824bb3c66c7602395a71
---

# feat(setup): /setup-red-skills installs the autonomous AFK lane (opt-in) + workflow catalogue

- **PR:** [#680](https://github.com/reddb-io/red-skills/pull/680)
- **Author:** @filipeforattini
- **Merge SHA:** `1df770c6b0d0d75d9418824bb3c66c7602395a71`
- **Format:** merged pull request

## Summary

Answers the gap you flagged: `/setup-red-skills` only installed `red-issues-needs-triage.yml`, so an adopter got auto-triage but **not** the offline/headless AFK execution lane (`red-afk-attempt`) — and the setup skill didn't even mention it.

## What
- **Section D opt-in (default NO): the autonomous AFK execution lane.** Installs `red-afk-attempt.yml` from `../afk/examples/red-afk-attempt-caller.yml`, edits the trust-gate allowlist, and prints secret-setup guidance (`MINIMAX_API_KEY`/`OPENAI_API_KEY`/`OPENROUTER_API_KEY` — the user provisions secrets; setup never sets them). **Off by default** (needs secrets + trust gate + autonomous PRs = deliberate), unlike the on-by-default `needs-triage`.
- **New `WORKFLOWS.md` catalogue** — every `red-*` workflow, split into **adopter-installable** (`needs-triage` default-yes, `afk-attempt` opt-in) vs **red-skills' own CI** (release, drift-guard, bench, wiki-extract, upstream-watch). Linked from Section D.
- The lane template is **referenced from `afk/examples/`** (not duplicated into `setup-red-skills/workflows/`), so the "copy each `red-*.yml`" default set stays `needs-triage`-only and the lane stays opt-in.

## Net effect
A repo running `/setup-red-skills` can now opt into headless AFK execution (issue → autonomous PR via Actions) during onboarding, with clear prerequisites — instead of hand-copying the caller.

## Validation
Links resolve; `scripts/validate-agent-metadata.sh` → `agent metadata ok`; `doctor-docs` + `label-vocabulary-docs` tests green. No watched memory surfaces.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/680"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783743907&installation_id=129708444&pr_number=680&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F680&signature=7f030f3172bb75cbb555bcb1f0bc9d7dfcfb858d669a174f0a27eb2e2db54d58"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(setup): /setup-red-skills can install the autonomous AFK Actions…

## Files changed

- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/WORKFLOWS.md`

