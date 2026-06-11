---
title: docs(adr): reconcile the ADR map — 0008→0030, 0053 Status, brain/bash/memory notes (closes #595)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-689]
pr: 689
merge_sha: 79ec4b48357c02d021f2d27dd76899f63ad05c93
---

# docs(adr): reconcile the ADR map — 0008→0030, 0053 Status, brain/bash/memory notes (closes #595)

- **PR:** [#689](https://github.com/reddb-io/red-skills/pull/689)
- **Author:** @filipeforattini
- **Merge SHA:** `79ec4b48357c02d021f2d27dd76899f63ad05c93`
- **Format:** merged pull request

## Summary

PRD #567 slice. Pure ADR-map reconciliation (no new decision).

- **0008 Status** → records the merge *mechanism* is superseded by **0030** (lock-toggled landing); base-resolution (pin > main) stands, refined by 0031.
- **0053** → gains the missing `## Status` (+ `## Context`).
- **INDEX**: 0021 notes it predates `brain` (multi-context now spans dev/memory/brain); AFK-section note that `*.sh` refs are historical parity anchors post the bash→TS port (0032/0034); Memory-section note that the runtime moved to `red-memory` post-0041.
- **0055** was already in INDEX (finding already satisfied).

The prior AFK attempt only failed on a flaky `test:root` on the old `src/apps` tree — this is done fresh on current main. review-adrs-docs + doctor-docs green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/689"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783747204&installation_id=129708444&pr_number=689&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F689&signature=bdccac5a73b34d73e7db3b23918f42991e3efae08e37199791ff6928a224a08e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated architecture decision records with status clarifications and governance model refinements
  * Revised ADR index entries to document multi-context model scope, AFK execution references, and memory component organization changes

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(adr): reconcile the ADR map — 0008→0030 supersession, 0053 Statu…

## Files changed

- `.red/adr/0008-afk-merges-into-the-pinned-branch.md`
- `.red/adr/0053-provider-tidy-is-report-only-governance.md`
- `.red/adr/INDEX.md`

