---
title: docs(adr): 0040 version single-source + version-aware; 0039 two-MCP memory plugin; doctor checks 6/7
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-385]
pr: 385
merge_sha: 0c21e6a5a0ba93fa677497ced9589126f57d1271
---

# docs(adr): 0040 version single-source + version-aware; 0039 two-MCP memory plugin; doctor checks 6/7

- **PR:** [#385](https://github.com/reddb-io/red-skills/pull/385)
- **Author:** @filipeforattini
- **Merge SHA:** `0c21e6a5a0ba93fa677497ced9589126f57d1271`
- **Format:** merged pull request

## Summary

Follows up the deploy break (manifest version drift that failed red-release 3×) and the clarification that **both** the memory and red-ui MCPs live inside the memory plugin.

- **ADR 0039** — explicit end-state `plugins/memory/.mcp.json`: `red-memory` (data) **and** `red-ui` (visualizer) as fetched consumers, replacing today's standalone-local `memory` bootstrap server; both version-keyed.
- **ADR 0040 (new)** — version is a single source, written by one script (`scripts/set-version.sh`) that red-release calls; `validate-install-metadata.sh` stays the gate; CLIs/launchers version-aware via `build-info` + `--version`. Removes the 'edit one manifest, forget the other' footgun that broke today's release.
- **/dev:doctor** — check 6 refined (expect red-memory+red-ui consumers; flag standalone-local memory) and **check 7** added (cross-manifest version coherence, `→ release` fix-home) so the doctor would have caught today's drift before release.

Docs + skill only; no manifest/version files touched.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/385"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782998151&installation_id=129708444&pr_number=385&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F385&signature=4fbee15fabb76b6a48ba8983ed33b05f177a42758c85404e11e54af7760677ed"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(adr): 0040 version single-source + version-aware CLIs; 0039 expl…

## Files changed

- `.red/adr/0039-red-skills-consumes-red-memory-and-red-ui-mcps.md`
- `.red/adr/0040-version-is-single-source-one-writer-version-aware-clis.md`
- `plugins/dev/skills/engineering/doctor/SKILL.md`

