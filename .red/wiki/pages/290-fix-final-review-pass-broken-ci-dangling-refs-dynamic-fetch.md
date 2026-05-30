---
title: fix: final-review pass — broken CI, dangling refs, dynamic-fetch shipping
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-290]
pr: 290
merge_sha: 8a5f9e387a55cb156df858c78f5a3f4b536a2513
---

# fix: final-review pass — broken CI, dangling refs, dynamic-fetch shipping

- **PR:** [#290](https://github.com/reddb-io/red-skills/pull/290)
- **Author:** @filipeforattini
- **Merge SHA:** `8a5f9e387a55cb156df858c78f5a3f4b536a2513`
- **Format:** merged pull request

## Summary

Final review of the post-restructure repo found and fixed real breakage: memory unit gate (2 failing tests → 657/657), the drift-guard CI workflow (dead path), the dynamic fetcher (red-fetch.mjs was never shipped — now committed + wired), memory-bridge + /curate resolution in cache installs, and doc/manifest consistency (statusline in READMEs, dead links, license, dangling refs). [skip release].

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/290"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782767525&installation_id=129708444&pr_number=290&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F290&signature=ed41c6a18cb64d83ec18e03ea757304d6a87db163b553ff41600b2876cb79edb"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix: resolve all final-review findings — broken CI, dangling refs, dy…

## Files changed

- `.github/workflows/red-memory-drift-guard.yml`
- `.github/workflows/red-release.yml`
- `README.md`
- `plugins/dev/.codex-plugin/plugin.json`
- `plugins/dev/hooks/claude.hooks.json`
- `plugins/dev/hooks/red-fetch.mjs`
- `plugins/dev/scripts/memory-bridge.sh`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/curate/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `src/domains/memory/tests/public-docs-claims.test.ts`

