---
title: chore(afk): default the OpenCode/Actions lane to minimax/MiniMax-M3
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-696]
pr: 696
merge_sha: 386fa76ac5b539e8658fd5eaa234c9aced65af7a
---

# chore(afk): default the OpenCode/Actions lane to minimax/MiniMax-M3

- **PR:** [#696](https://github.com/reddb-io/red-skills/pull/696)
- **Author:** @filipeforattini
- **Merge SHA:** `386fa76ac5b539e8658fd5eaa234c9aced65af7a`
- **Format:** merged pull request

## Summary

Sets `afk.models.opencode.base.model: minimax/MiniMax-M3` in the committed `.red/config.yaml` so the **Actions lane** (reads config from the git checkout) defaults **every** opencode tier to MiniMax M3. Uses the `base` knob from #694 — one line covers validate/simple/complex/think (each keeps its default effort); specialize a tier with `afk.models.opencode.<tier>.model`.

**Verified:** `loadConfig` + `resolveTier` → all four opencode tiers resolve to `minimax/MiniMax-M3`.

Needs `MINIMAX_API_KEY` set as a repo secret to actually run. If the exact slug differs (e.g. `MiniMax-M2`), it's a one-line tweak.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/696"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783772936&installation_id=129708444&pr_number=696&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F696&signature=397ab33748cb09b8cc2ede740746d30c75e13f4a18b8058b26e69a9f9963db79"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Chores**
  * Set the default model for OpenCode/Actions tiers to MiniMax-M3.
  * Added inline documentation clarifying that a base model populates various tiers automatically and that individual tiers can be overridden independently.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(afk): default the OpenCode/Actions lane to minimax/MiniMax-M3

## Files changed

- `.red/config.yaml`

