---
title: refactor(dev): rename the statusline skill to setup-statusline
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-410]
pr: 410
merge_sha: 51ffc714340df7f5e3f02c69ed0ede68f433b006
---

# refactor(dev): rename the statusline skill to setup-statusline

- **PR:** [#410](https://github.com/reddb-io/red-skills/pull/410)
- **Author:** @filipeforattini
- **Merge SHA:** `51ffc714340df7f5e3f02c69ed0ede68f433b006`
- **Format:** merged pull request

## Summary

Renames `/statusline` → `/setup-statusline` to align with the **setup-*** family (it's an install/inspect skill that pairs with `/setup-red-skills`, which references it).

- `git mv` the skill dir `engineering/statusline` → `engineering/setup-statusline`
- frontmatter `name:` + the `/statusline`|`$statusline` invocation line
- `plugins/dev/.claude-plugin/plugin.json` registration
- `/setup-red-skills` Section F cross-ref
- root README table + engineering bucket README entries

**Untouched on purpose:** the AFK bundle's `statusline` *subcommand* (`afk.mjs statusline` — the runtime line producer) and the doctor's *'statusline drift'* check; those name the feature, not the skill. `.codex-plugin` auto-includes via its `./skills/` wildcard. `validate-install-metadata.sh` passes; no leftover `engineering/statusline` refs. Original skill → no CHANGES.md.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/410"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783034113&installation_id=129708444&pr_number=410&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F410&signature=0ac4ca3e94cbc04e5a32da94250ea3827581b568270722070d36aac1920995d0"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Renamed statusline setup skill to "setup-statusline" with updated command names across Claude Code and Codex environments.
  * Updated all documentation references and plugin configuration to reflect the skill rename across multiple files.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- refactor(dev): rename the statusline skill to setup-statusline

## Files changed

- `README.md`
- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-statusline/SKILL.md`

