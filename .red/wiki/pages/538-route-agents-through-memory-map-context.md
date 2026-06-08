---
title: Route agents through Memory map context
type: source
tags: [pr, merged]
created: 2026-06-07
updated: 2026-06-07
sources: [pr-538]
pr: 538
merge_sha: 6fbff0f0f599c852830c380e242537c4a824a19e
---

# Route agents through Memory map context

- **PR:** [#538](https://github.com/reddb-io/red-skills/pull/538)
- **Author:** @filipeforattini
- **Merge SHA:** `6fbff0f0f599c852830c380e242537c4a824a19e`
- **Format:** merged pull request

## Summary

Closes #526.\n\n## Summary\n- add Memory routing-guide map context for broad source-read avoidance\n- document relation-filter examples for call/import/type/validation/decision/work/reference\n- clarify MCP/CLI surfaces return agent context, not generated answers\n- cover routing JSON/text/viewer output with tests and snapshot\n\n## Validation\n- pnpm --dir src/apps/memory typecheck\n- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/routing-guide.test.ts\n- pnpm --dir src/apps/memory exec vitest run tests/viewer-rendering.test.ts\n\nNote: the default memory test suite was also run during verification and passed all non-snapshot tests; the only failure was the expected routing-guide viewer snapshot mismatch before updating the snapshot.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/538"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783386970&installation_id=129708444&pr_number=538&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F538&signature=0476d950db067b6b8c8ca1a2bb529f24c3f32139c062b92ce3828aca06f2fc51"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Viewer and CLI now show a "Map Context" section that lists relation filters and example guidance to narrow what to read next.

* **Documentation**
  * Expanded Memory workflows and routing guidance, emphasizing map-context is for selecting source reads (not generated answers) and adding onboarding/verification command examples.

* **Tests**
  * Updated tests to validate map-context content in JSON, text output, and rendered viewer HTML.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(memory): route agents through map context
- Merge remote-tracking branch 'origin/main' into afk/wHCD4/526-route-a…

## Files changed

- `plugins/memory/README.md`
- `src/apps/memory/src/operations.ts`
- `src/apps/memory/src/routing-guide-viewer.ts`
- `src/apps/memory/src/routing-guide.ts`
- `src/apps/memory/tests/__snapshots__/viewer-rendering.test.ts.snap`
- `src/apps/memory/tests/routing-guide.test.ts`

