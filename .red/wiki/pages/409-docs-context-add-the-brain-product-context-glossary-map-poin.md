---
title: docs(context): add the brain product context (glossary + map pointer)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-409]
pr: 409
merge_sha: 96147d594717f3a0c56f0b6ec0e07ce39919f319
---

# docs(context): add the brain product context (glossary + map pointer)

- **PR:** [#409](https://github.com/reddb-io/red-skills/pull/409)
- **Author:** @filipeforattini
- **Merge SHA:** `96147d594717f3a0c56f0b6ec0e07ce39919f319`
- **Format:** merged pull request

## Summary

Groundwork for the new **brain** plugin — a third RedSkills product context (project-local, human-facing knowledge repository: freeform captures, project brain files, cross-note connections, GBrain-style dumping).

- Adds `.red/contexts/brain/CONTEXT.md` (the brain glossary).
- Registers it in `.red/CONTEXT-MAP.md` (two contexts → three) with the `Brain → Memory` and `Brain → Dev` relationships.

Context glossary only — the `plugins/brain/` tree (plugin.json, skills, marketplace + README registration) lands later when the plugin is built. Captured from the live working tree at the maintainer's request and landed via worktree (no push from the primary checkout).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/409"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783032659&installation_id=129708444&pr_number=409&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F409&signature=5d7d06d99a8f9797a7cc3b69d7aab1350934de24f8623dc070a089df9565165d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated internal context mapping documentation to include the new "Brain" context.
  * Added comprehensive documentation for the Brain context, including terminology, operation contracts, and connection pipeline specifications.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(context): add the brain product context (glossary + map pointer)
- docs(context): mark brain-context drift for deferred ingest

## Files changed

- `.red/CONTEXT-MAP.md`
- `.red/contexts/brain/CONTEXT.md`

