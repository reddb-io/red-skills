---
title: decision(adr): introduce the brain plugin (ADR 0063) + amend 0021 (closes #596)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-691]
pr: 691
merge_sha: 92411517de39d2875119e8cfa064b88fe8b64089
---

# decision(adr): introduce the brain plugin (ADR 0063) + amend 0021 (closes #596)

- **PR:** [#691](https://github.com/reddb-io/red-skills/pull/691)
- **Author:** @filipeforattini
- **Merge SHA:** `92411517de39d2875119e8cfa064b88fe8b64089`
- **Format:** merged pull request

## Summary

PRD #567 slice. The `brain` plugin shipped in production with **no introducing ADR**, and ADR 0021 (multi-context glossaries) enumerated only dev/memory while `.red/contexts/brain/` already existed. Two human calls were open; **resolved with the maintainer**:

**Q1 — brain's home:** stays in red-skills for now (actively developed — PRD #463 command-center, draft #422), unlike memory which left for `red-memory` (ADR 0041) only after maturing. Door stays open to follow that split later.
**Q2 — ADR 0021:** amended in place (the multi-context model is unchanged; only the context count grew).

Changes:
- **ADR 0063** (new) — brain is a first-class plugin alongside dev/memory; reuses the fetch (0038) / version (0040) / apps-layout (0034/0060) / Hermes (0057) patterns; home + reconciliation decisions recorded.
- **ADR 0021** amended to enumerate the `brain` context (+ an amendment note).
- **INDEX** gains the 0063 entry under the Brain plugin group.

review-adrs-docs + doctor-docs green.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/691"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783747591&installation_id=129708444&pr_number=691&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F691&signature=52c8678617310e635e433e6a40ba288619447f6f11c35f24e967ddc2fd605b21"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Established the brain plugin as a first-class component within the red-skills system
  * Updated architecture documentation to recognize brain as a third context in the multi-context glossary
  * Documented ownership scope and integration patterns for the brain plugin, including knowledge repository and connector support

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- decision(adr): introduce the brain plugin (ADR 0063) + amend 0021 for…

## Files changed

- `.red/adr/0021-multi-context-plugin-glossaries.md`
- `.red/adr/0063-brain-plugin-is-the-third-red-skills-context.md`
- `.red/adr/INDEX.md`

