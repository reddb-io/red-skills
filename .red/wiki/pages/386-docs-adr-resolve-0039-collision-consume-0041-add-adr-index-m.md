---
title: docs(adr): resolve 0039 collision (consume→0041) + add ADR INDEX.md
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-386]
pr: 386
merge_sha: f19be57060706245d82fa857f488e0b8cf8aae9e
---

# docs(adr): resolve 0039 collision (consume→0041) + add ADR INDEX.md

- **PR:** [#386](https://github.com/reddb-io/red-skills/pull/386)
- **Author:** @filipeforattini
- **Merge SHA:** `f19be57060706245d82fa857f488e0b8cf8aae9e`
- **Format:** merged pull request

## Summary

`/dev:review-adrs` caught a real numbering collision: **two ADRs numbered 0039** on main — `0039-plugin-entrypoints-share-one-source` (launcher unification, sibling of 0038/0040) and `0039-red-skills-consumes-red-memory-and-red-ui-mcps` (ecosystem split). The consume ADR was landed off a stale local checkout that hadn't pulled the entrypoints one — the same number-grab race that hit 0038.

- Renumber the **consume** ADR `0039 → 0041` (0040 taken); the entrypoints ADR keeps 0039.
- Disambiguate refs: consume-meaning `0039`→`0041` in ADR 0040 + `/dev:doctor` + `/dev:review-adrs`; launcher-meaning `0038/0039` left intact.
- Add **`.red/adr/INDEX.md`** — thematic decision map (Pass 2 of review-adrs), flagging the still-open **0005** double-number for a maintainer call.

Docs + skill text only.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/386"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782999170&installation_id=129708444&pr_number=386&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F386&signature=da396d0184b74c9bfcf9ff63bc286ca82b6d42d545e266d14aba49d9b34281ec"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(adr): resolve 0039 collision (renumber consume -> 0041) + add AD…

## Files changed

- `.red/adr/0040-version-is-single-source-one-writer-version-aware-clis.md`
- `.red/adr/0041-red-skills-consumes-red-memory-and-red-ui-mcps.md`
- `.red/adr/INDEX.md`
- `plugins/dev/skills/engineering/doctor/SKILL.md`
- `plugins/dev/skills/engineering/review-adrs/SKILL.md`

