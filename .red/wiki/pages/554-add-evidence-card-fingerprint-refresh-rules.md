---
title: Add Evidence card fingerprint refresh rules
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-554]
pr: 554
merge_sha: 555d7805f12f9422902c3d0b490e4a58344ebd01
---

# Add Evidence card fingerprint refresh rules

- **PR:** [#554](https://github.com/reddb-io/red-skills/pull/554)
- **Author:** @filipeforattini
- **Merge SHA:** `555d7805f12f9422902c3d0b490e4a58344ebd01`
- **Format:** merged pull request

## Summary

Closes #548

## Summary
- Adds deterministic Evidence card fingerprints from telemetry source, refinement route, dominant error pattern, and telemetry window.
- Refreshes unresolved cards while preserving review metadata and avoids reusing cards with terminal/reviewed status or human decision metadata.
- Adds regression coverage for unresolved refresh and reviewed-card preservation.

## Validation
- pnpm --filter @reddb-io/memory exec vitest run --config vitest.integration.config.ts tests/improve-skills.test.ts
- pnpm --filter @reddb-io/memory typecheck

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/554"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783486752&installation_id=129708444&pr_number=554&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F554&signature=d06751dd4a523aaa17c1a95b2d15f8d2e74e8f33add1f0175a2c36a92a98e4e2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Added Brain command-line interface with capture, search, and synthesis capabilities
  * Introduced evidence card tracking in Memory proposals with fingerprint-based refresh behavior
  * Added curator skill workflow for archiving and restoring skill candidates

* **Documentation**
  * Enhanced Brain and Memory context definitions with new artifact types and workflow concepts
  * Added governance guidance for provider tidy as report-only until explicit approval
  * Updated proposal lifecycle and fingerprinting documentation

* **Tests**
  * Added end-to-end tests validating evidence card refresh and archival behavior

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- Add evidence card fingerprint refresh rules

## Files changed

- `plugins/memory/README.md`
- `plugins/memory/skills/core/improve-skills/SKILL.md`
- `src/apps/memory/src/cli.ts`
- `src/apps/memory/tests/improve-skills.test.ts`

