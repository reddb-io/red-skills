---
title: merge: #472 red-hermes ADR 0057 + NOTICE + contract (salvage)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-566]
pr: 566
merge_sha: a336c3dc2deb9c0b5977db8a051b591073404f46
---

# merge: #472 red-hermes ADR 0057 + NOTICE + contract (salvage)

- **PR:** [#566](https://github.com/reddb-io/red-skills/pull/566)
- **Author:** @filipeforattini
- **Merge SHA:** `a336c3dc2deb9c0b5977db8a051b591073404f46`
- **Format:** merged pull request

## Summary

Salvage-land of #472 (HITL-resolved: fetch via Release/ADR 0038). Inner agent finished+committed (ADR 0057, NOTICE MIT, 10-tool contract verified vs channel-bridge.ts) but looped without emitting DONE. Renumbered its ADR 0056→0057 to resolve collision with #563's 0056. Closes #472.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/566"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783559150&installation_id=129708444&pr_number=566&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F566&signature=e71ec67494010a38edb7a2855e09ea7d6e32962ad05a5b5789398ed464291731"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(brain): ADR 0056 — red-hermes is a fetched black-box brain depen…
- Merge remote-tracking branch 'origin/main' into HEAD
- docs(adr): renumber red-hermes ADR 0056→0057 (collision with #563's 0…

## Files changed

- `.red/adr/0057-brain-depends-on-fetched-never-vendored-red-hermes-black-box.md`
- `.red/adr/INDEX.md`
- `.red/contexts/brain/CONTEXT.md`
- `NOTICE`

