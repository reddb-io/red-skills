---
title: chore(dev): remove the scaffold-exercises skill (upstream course tooling)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-411]
pr: 411
merge_sha: 8e02ac29f5275c62b099cfcb27b4537fcbe1e3e7
---

# chore(dev): remove the scaffold-exercises skill (upstream course tooling)

- **PR:** [#411](https://github.com/reddb-io/red-skills/pull/411)
- **Author:** @filipeforattini
- **Merge SHA:** `8e02ac29f5275c62b099cfcb27b4537fcbe1e3e7`
- **Format:** merged pull request

## Summary

`scaffold-exercises` is an **upstream (mattpocock / AI Hero)** course-exercise scaffolder — it targets `pnpm ai-hero-cli internal lint` and an `exercises/` directory tree that no reddb.io repo has. Pure dead weight parked in `misc/`, unrelated to reddb.io engineering.

- `git rm -r` the skill dir
- removed from `plugins/dev/.claude-plugin/plugin.json`, the root README table, and the `misc/` bucket README
- `.codex-plugin` drops it via its `./skills/` wildcard
- recorded in **CHANGES.md** (`status: removed`, upstream `e3b90b5`) per the repo's upstream-change rule

`validate-install-metadata.sh` passes; no leftover refs.

(Sibling `migrate-to-shoehorn` — same upstream-course category — left for a separate call.)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/411"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783034374&installation_id=129708444&pr_number=411&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F411&signature=da6f49ed2dbff952729cba7fb3c75a8f62f13ec71c65f68813b4d03271fa28f4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Chores**
  * Removed `scaffold-exercises` skill from the misc utilities collection.
  * Updated skill registry and documentation references.
  * Added new misc skills: `branch-lock`, `git-guardrails-claude-code`, `migrate-to-shoehorn`, and `setup-pre-commit`.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore(dev): remove the scaffold-exercises skill (upstream course tool…

## Files changed

- `CHANGES.md`
- `README.md`
- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/skills/misc/README.md`
- `plugins/dev/skills/misc/scaffold-exercises/SKILL.md`

