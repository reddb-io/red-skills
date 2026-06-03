---
title: docs(adr): 0049 — model-tier routing embedded in the plugin, enforced by the shared trio (per runner)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-445]
pr: 445
merge_sha: 0a7ccb43f04367fcb937d3a4c767adcf1f168ba6
---

# docs(adr): 0049 — model-tier routing embedded in the plugin, enforced by the shared trio (per runner)

- **PR:** [#445](https://github.com/reddb-io/red-skills/pull/445)
- **Author:** @filipeforattini
- **Merge SHA:** `0a7ccb43f04367fcb937d3a4c767adcf1f168ba6`
- **Format:** merged pull request

## Summary

Records the /start decision: route work to the cheapest capable model/effort across the interactive session **and** the AFK loop, **both runners**. Single tier table in the plugin config defaults (per-runner `{model,effort}`), consumed by the three host-neutral shared surfaces — **skill** (policy), **hooks** (interactive enforcement), **sandcastle** (AFK spawn `--model`/`--effort`). Per-runner adapters (ADR 0003); deterministic-first validation; per-issue classification + escalate-on-failure; deliberate effort inversion. Status: accepted (not yet implemented) — `/to-prd` next to slice the build.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/445"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783093212&installation_id=129708444&pr_number=445&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F445&signature=915df61b4e8edcec909e505a0ae37fade03fa19a6832c6243c14543eabe679f2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Added architectural decision record documenting the model-tier routing policy for optimized task allocation across different complexity levels.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(adr): 0049 — model-tier routing embedded in the plugin, enforced…

## Files changed

- `.red/adr/0049-model-tier-routing-embedded-in-plugin-enforced-by-shared-trio.md`
- `.red/adr/INDEX.md`

