---
title: Add Evidence-linked Skill improvement proposals
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-553]
pr: 553
merge_sha: 4bc3648aa1593e31e01d7d7015ddb36e8235ac28
---

# Add Evidence-linked Skill improvement proposals

- **PR:** [#553](https://github.com/reddb-io/red-skills/pull/553)
- **Author:** @filipeforattini
- **Merge SHA:** `4bc3648aa1593e31e01d7d7015ddb36e8235ac28`
- **Format:** merged pull request

## Summary

## Summary
- link generated Skill improvement proposals to YAML Evidence cards
- write proposal path back into the Evidence card for bidirectional traceability
- keep cardless proposal list/show/archive/apply behavior compatible
- avoid duplicating raw recent telemetry event listings in carded proposals

## Validation
- pnpm --dir src/apps/memory exec vitest run --config vitest.integration.config.ts tests/improve-skills.test.ts
- pnpm --dir src/apps/memory typecheck

Closes #547

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/553"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783484636&installation_id=129708444&pr_number=553&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F553&signature=56a8d177d9d0406330e08eec7e993cf05cdffc07148b672046c4035f9fe48dd3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Skill improvement proposals now show provided evidence cards without duplicating recent failure sections, and evidence cards are identified more consistently so they can be reused across runs.
* **Tests**
  * End-to-end tests expanded to verify evidence-card reuse, single-file inbox behavior, and updated proposal content expectations.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- chore: save local work
- Add evidence-linked skill improvement proposals
- Merge origin/main into evidence-linked proposals
- Fix evidence proposal merge duplicates
- Deduplicate evidence cards by proposal fingerprint
- Avoid overwriting archived evidence cards

## Files changed

- `src/apps/memory/src/cli.ts`
- `src/apps/memory/tests/improve-skills.test.ts`

