---
title: docs(setup,doctor,afk): rs-* installed-workflow convention + adopter secret guide
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-725]
pr: 725
merge_sha: 69ddae3bba4c58950930eaacc0f0afe0df69f50f
---

# docs(setup,doctor,afk): rs-* installed-workflow convention + adopter secret guide

- **PR:** [#725](https://github.com/reddb-io/red-skills/pull/725)
- **Author:** @filipeforattini
- **Merge SHA:** `69ddae3bba4c58950930eaacc0f0afe0df69f50f`
- **Format:** merged pull request

## Summary

## What

Codify the **`red-*` (source) → `rs-*` (installed)** workflow naming convention and give adopters a **per-provider secret guide** — including the public-repo org-secret gotcha that silently resolves the auth key to an empty string.

## Why

While bringing up the AFK GitHub Actions lane, the run failed twice on adopter-facing gaps that weren't documented:
- the installed-workflow naming convention (`red-afk-worker` → `rs-afk-worker`) was agreed verbally but lived nowhere in the skills;
- `MINIMAX_API_KEY` resolved **empty** because red-skills is public and org secrets aren't shared with public repos by default — no error, just an auth failure downstream.

## Changes

- **`setup-red-skills/WORKFLOWS.md`** — new "`red-*` (source) vs `rs-*` (installed)" convention section + a source→installed mapping table. The reusable `red-afk-attempt.yml` is referenced by `uses:`, never copied.
- **`setup-red-skills/SKILL.md`** — Section D is now an explicit **menu**: ask which workflows + which configs (provider/model/triggers). Install copies are renamed `rs-<name>.yml`. AFK-lane prereqs carry the public-repo secret note.
- **`afk/actions-lane.md`** — new **"Configuring secrets (per provider)"** section with the public-repo org-secret gotcha + a `gh secret list` verification step. Install target is `rs-afk-attempt.yml`. `MiniMax-M2` → `M3`.
- **`doctor/SKILL.md`** — new read-only **check 10** (installed `rs-*` adoption: naming drift + AFK-lane auth gap via `gh secret list`, names-only). Boundary reworded: still never imposes our `red-*` CI, but now audits `rs-*` adoption coherence.
- **caller example + `config-template.yaml` + `model-tier-policy`** — `MiniMax-M2` → `M3`.

Docs/skills only — no runtime code touched.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/725"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783820952&installation_id=129708444&pr_number=725&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F725&signature=bfebb17cd39e720a12618424cb6ac3b10493d323e9bd3b9d1908af0a9890d289"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Enhanced AFK Actions lane documentation with expanded provider-specific secrets configuration guidance
  * Clarified workflow naming conventions and installation instructions mapping source to deployed workflows
  * Refined AFK lane setup steps with model selection, trigger configuration, and authentication guidance
  * Updated model tier examples to reflect latest supported tier across templates and documentation

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(setup,doctor,afk): rs-* installed-workflow convention + adopter …

## Files changed

- `plugins/dev/skills/engineering/afk/actions-lane.md`
- `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-caller.yml`
- `plugins/dev/skills/engineering/doctor/SKILL.md`
- `plugins/dev/skills/engineering/model-tier-policy/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/WORKFLOWS.md`
- `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`

