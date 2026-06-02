---
title: feat(dev): review-adrs skill — decision-record doctor (lint + group + propagate)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-382]
pr: 382
merge_sha: c88b2b7c95c13f7ea0eb203f4cb53a1bdd85441f
---

# feat(dev): review-adrs skill — decision-record doctor (lint + group + propagate)

- **PR:** [#382](https://github.com/reddb-io/red-skills/pull/382)
- **Author:** @filipeforattini
- **Merge SHA:** `c88b2b7c95c13f7ea0eb203f4cb53a1bdd85441f`
- **Format:** merged pull request

## Summary

Adds **`/dev:review-adrs`** — the "doctor of decisions", sibling to `/dev:doctor` (adoption) and `memory:doctor` (graph).

ADRs accumulate (30–40+/repo) and derive: one reverses another, a cited path moves, and wiki/memory claims sourced from a decision go stale. This skill makes that drift visible and keeps the derived knowledge in sync.

## Three passes
1. **Lint (read-only)** — contradictions, missing "superseded by" links, stale references (paths/commands that moved, e.g. `src/domains` → `src/apps`), and ADR number collisions (the 0038 double-grab this session).
2. **Group** — cluster ADRs by theme into a proposed `.red/adr/INDEX.md` (decision map; the ADR analogue of `CONTEXT-MAP.md`); may reuse Memory graph communities.
3. **Propagate (gated)** — `/wiki lint` + re-ingest for pages referencing a changed ADR; `memory_supersede` for graph nodes whose provenance cites it.

Lint + grouping are read-only/propositional; index/wiki/memory writes are **gated on approval** (never silently rewrites a decision, the wiki, or the graph). Composes existing surfaces (`/wiki lint`, Memory supersession) instead of reimplementing them.

Registered in `plugin.json` + both READMEs; Codex picks it up via the `./skills/` wildcard.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/382"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782996444&installation_id=129708444&pr_number=382&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F382&signature=4c11f825c64d778a3022aebf13b3dfabbc1fc809832ac445abdd84033bc80564"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(dev): add review-adrs skill (decision-record doctor)

## Files changed

- `README.md`
- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/review-adrs/SKILL.md`

