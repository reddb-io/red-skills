---
title: chore(upstream): bump pin to e3b90b5 (no cherry-picks)
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-262]
pr: 262
merge_sha: ea6145eb37c13911bd2975a3add9d60f3a4e67d2
---

# chore(upstream): bump pin to e3b90b5 (no cherry-picks)

- **PR:** [#262](https://github.com/reddb-io/red-skills/pull/262)
- **Author:** @filipeforattini
- **Merge SHA:** `ea6145eb37c13911bd2975a3add9d60f3a4e67d2`
- **Format:** merged pull request

## Summary

Resolves #259.

Upstream `mattpocock/skills` advanced `0288510 → e3b90b5` with a single commit refining `grill-with-docs/CONTEXT-FORMAT.md`.

**Decision: no cherry-pick.** That file is our `/start` skill's `CONTEXT-FORMAT.md` (renamed-from `grill-with-docs`), which has intentionally diverged. The upstream change *removes* three rules our grilling flow relies on (Flag conflicts explicitly / Show relationships / Write an example dialogue) and loosens `Keep definitions tight` where we already diverged to "One sentence max". Adopting it would regress `/start`. Same call as the prior drift #195.

- Bumped `.upstream` → `e3b90b5`
- Recorded the skip decision in `CHANGES.md`
- No skill content changed

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/262"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782710054&installation_id=129708444&pr_number=262&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F262&signature=4d5d40e66e6c237dc21412e04ed6cbbec48221bbb70f81d6013b5fd256195806"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- chore(upstream): bump pin to e3b90b5 (no cherry-picks)

## Files changed

- `.upstream`
- `CHANGES.md`

