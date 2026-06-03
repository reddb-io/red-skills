---
title: feat(afk): attempt envelopes link the live worker branch as a clickable tree link (#443)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-466]
pr: 466
merge_sha: 5d073ed0efbf543080acd918597a2ef6cf4ec875
---

# feat(afk): attempt envelopes link the live worker branch as a clickable tree link (#443)

- **PR:** [#466](https://github.com/reddb-io/red-skills/pull/466)
- **Author:** @filipeforattini
- **Merge SHA:** `5d073ed0efbf543080acd918597a2ef6cf4ec875`
- **Format:** merged pull request

## Summary

Closes #443.

The terminal-failure `data-section="diff"` linked only the `afk-attempts/*` **snapshot**. This adds a clickable **live-branch** `tree/afk/{id}/{N}-slug` link — the live ref survives on origin after a terminal failure, so a reviewer can `git checkout` the in-progress branch to inspect or continue — rendered alongside the existing afk-attempts compare link.

Threaded the live branch (already on the emitter as `input.branch`) through `DiffInputs` → `buildDiffSection`; omitted cleanly when absent. `envelope-emit.test.ts` +2 (live link present with both links; omitted when unset); SKILL.md diff-section doc updated.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/466"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783107960&installation_id=129708444&pr_number=466&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F466&signature=262e0c09da2b2aa2b3a4117e931f8ab71fb81405f7eea3ce775356cb268cb33d"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Added live branch links to AFK iteration failure reports, enabling direct navigation to remote worker branches that persist after terminal failures alongside existing comparison links.

* **Tests**
  * Added test coverage for live branch link rendering in diff sections, validating behavior with and without branch availability.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): attempt envelopes link the live worker branch (#443)

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `src/apps/dev/src/core/envelope-emit.ts`
- `src/apps/dev/tests/envelope-emit.test.ts`

