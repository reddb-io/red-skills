---
title: feat(afk): per-runner `base` model/effort auto-populates every tier (extends ADR 0049)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-694]
pr: 694
merge_sha: 66640b33f0750dec6392641cef0558a5c049f101
---

# feat(afk): per-runner `base` model/effort auto-populates every tier (extends ADR 0049)

- **PR:** [#694](https://github.com/reddb-io/red-skills/pull/694)
- **Author:** @filipeforattini
- **Merge SHA:** `66640b33f0750dec6392641cef0558a5c049f101`
- **Format:** merged pull request

## Summary

Set `afk.models.<runner>.base.model` (+ optional `base.effort`) **once** to point a whole runner at one provider/model — every tier inherits it — and still specialize a single tier with `.<tier>.model`, which overrides the base. Exactly the OpenCode/MiniMax case (no more repeating `minimax/MiniMax-M2` under validate/simple/complex/think).

**Precedence (model):** flag / `RED_AFK_MODEL` → explicit `.<tier>.model` → **`base.model` (new)** → legacy runner scalar → legacy global scalar → tier default. Effort mirrors it via `base.effort` (optional — omit to keep each tier's default effort). A tier left at its table default falls back to `base`; an explicitly set tier wins.

- `config.ts` — base folded into the model + effort resolution + precedence doc.
- `config.test.ts` — base auto-populates all tiers; specialized tier overrides; no cross-runner leak; `base.model`-only keeps per-tier efforts. **43/43**, typecheck clean.
- `config-template.yaml` — documents the opencode `base` block (MiniMax recipe).

Extends ADR 0049 (model-tier routing).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/694"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783772655&installation_id=129708444&pr_number=694&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F694&signature=e4c928477f36df220ff09a12093597ddfa887119ed5b67a9964ee925f9b02fb8"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Introduced a new base tier configuration system enabling centralized model and effort defaults that intelligently cascade to individual runner tiers with support for selective overrides and runtime environment variable precedence.

* **Documentation**
  * Added configuration template examples demonstrating opencode runner setup with base tier settings.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): per-runner `base` model/effort that auto-populates every t…

## Files changed

- `apps/dev/src/core/config.ts`
- `apps/dev/tests/config.test.ts`
- `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`

