---
title: fix(memory): skills invoke scripts/bootstrap.mjs, not the absent dist/cli.js
type: source
tags: [pr, merged]
created: 2026-05-29
updated: 2026-05-29
sources: [pr-231]
pr: 231
merge_sha: ab73d3fcee9dfdae37c76946bce87ebcb0dcb493
---

# fix(memory): skills invoke scripts/bootstrap.mjs, not the absent dist/cli.js

- **PR:** [#231](https://github.com/reddb-io/red-skills/pull/231)
- **Author:** @filipeforattini
- **Merge SHA:** `ab73d3fcee9dfdae37c76946bce87ebcb0dcb493`
- **Format:** merged pull request

## Summary

Follow-up to #229 / ADR 0029. The runtime moved off committed `dist/` to a bundle the bootstrap fetches, but the 10 core skills still invoked `${CLAUDE_PLUGIN_ROOT}/dist/cli.js` — which doesn't exist in an installed copy. So `/memory:recall`, `/memory:ingest`, `/memory:doctor`, etc. failed the same way the hooks did (surfaced when `/doctor` was run against the 1.127.1 install).

Points all 10 skills (recall, ingest, store, extract, init, doctor, export, skills-status, context-status, improve-skills) at `scripts/bootstrap.mjs`, which delegates any subcommand. Verified live against the installed 1.127.1 plugin: `bootstrap.mjs doctor` → `healthy — 0 of 1432 stale`; `status context` → score 6/8; `recall` → 10 matches. Also rewrites the `init` skill's obsolete "build the CLI on your machine" section for the fetch-on-first-use model.

Not in this PR: `plugins/memory/README.md` local-dev examples still use `node plugins/memory/dist/cli.js …` — those are contributor/local-build examples (relative repo path, dist exists after `pnpm build`), a different context from the installed plugin.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/231"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782608009&installation_id=129708444&pr_number=231&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F231&signature=c2be07f98a19340c2d7b0c2a99d0095b517a5781e2491e45802b948d468f2ab4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(memory): skills invoke scripts/bootstrap.mjs, not the absent dist…

## Files changed

- `plugins/memory/skills/core/context-status/SKILL.md`
- `plugins/memory/skills/core/doctor/SKILL.md`
- `plugins/memory/skills/core/export/SKILL.md`
- `plugins/memory/skills/core/extract/SKILL.md`
- `plugins/memory/skills/core/improve-skills/SKILL.md`
- `plugins/memory/skills/core/ingest/SKILL.md`
- `plugins/memory/skills/core/init/SKILL.md`
- `plugins/memory/skills/core/recall/SKILL.md`
- `plugins/memory/skills/core/skills-status/SKILL.md`
- `plugins/memory/skills/core/store/SKILL.md`

