---
title: fix(afk): make the red-afk-attempt Actions lane actually run + fire on pre-labeled issue creation
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-675]
pr: 675
merge_sha: 90c85c9c4fdc9aa337611f5eb26439e6486e9931
---

# fix(afk): make the red-afk-attempt Actions lane actually run + fire on pre-labeled issue creation

- **PR:** [#675](https://github.com/reddb-io/red-skills/pull/675)
- **Author:** @filipeforattini
- **Merge SHA:** `90c85c9c4fdc9aa337611f5eb26439e6486e9931`
- **Format:** merged pull request

## Summary

The AFK Actions lane (ADR 0059, #665) had its triggers and trust gate wired, but the lane **never actually executed** — the run step invoked a workspace-relative `afk.mjs` with no `checkout`, no Node setup, and no runner CLI on the runner. As merged it would fail at the run step (its own functionality is never exercised by PR CI, since it only triggers on `issues`/`workflow_call`/`dispatch`).

## What this fixes
**Execution wiring**
- `actions/checkout` + `actions/setup-node@22`
- Runner-CLI install selected by `RED_AFK_RUNNER`: `opencode-ai` (default), `@anthropic-ai/claude-code`, or `@openai/codex`
- `afk.mjs` fetches the prebuilt `dev` bundle from the GitHub Release (ADR 0038/0039) → no workspace build, no submodule in CI
- `GH_TOKEN` + a committer identity so `gh`/`git` (labels, envelope, PR, worker commits) work
- checkout/setup/install/run are gated on the trust verdict

**Trigger — issue creation**
- Add `issues: opened`: an issue **created already carrying `ready-for-agent`** fires the lane (trust-gated). Raw label-less issues still fall through to `red-issues-needs-triage` + the labeled path.
- `RED_AFK_RUNNER` resolved once at job scope; `issues:*` always use `opencode` (the API-auth runner — no host session in CI).

**Caller template**
- Fix the invalid reusable-as-a-step syntax → a reusable workflow is invoked at the **job level** (`jobs.<id>.uses:` with sibling `with:`/`secrets:`), no `runs-on`/`steps`.
- Declare an optional `anthropic_api_key` secret for the claude runner.
- `model_slug` documented as reserved (AFK reads the model from `.red/config.yaml`; per-run override isn't wired yet).

## Coverage vs. the two operability scenarios
- **Local `--runner` (claude/codex/opencode):** already supported (`parseRunnerFlag` + provider seam) — unchanged here.
- **CI on issue/label:** label path (existing) + **issue-creation-when-pre-labeled** (new), both trust-gated, now actually executing the same per-issue `afk run --once` routine.

## Validation
- `actionlint` clean on both files. End-to-end run requires a real labeled/opened issue event (not exercised by PR CI) — recommend a one-off live smoke after merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/675"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783739061&installation_id=129708444&pr_number=675&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F675&signature=4536d18f51d4caaa072a7a10d6ddf700f79733567fa373c6f8302bee8dd7782e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Updated AFK workflow to support additional issue triggers (both labeled and opened events).
  * Improved runner and model configuration handling for workflow execution.
  * Added support for Anthropic API integration.
  * Refined workflow reusable job invocation structure.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): make the red-afk-attempt Actions lane actually run + fire o…

## Files changed

- `.github/workflows/red-afk-attempt.yml`
- `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-caller.yml`

