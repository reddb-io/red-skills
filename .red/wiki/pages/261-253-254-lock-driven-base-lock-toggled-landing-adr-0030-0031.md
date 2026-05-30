---
title: #253/#254: lock-driven base + lock-toggled landing (ADR 0030/0031)
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-261]
pr: 261
merge_sha: 6d28ae257a9c0e20433827ef3ea88e074578ca95
---

# #253/#254: lock-driven base + lock-toggled landing (ADR 0030/0031)

- **PR:** [#261](https://github.com/reddb-io/red-skills/pull/261)
- **Author:** @filipeforattini
- **Merge SHA:** `6d28ae257a9c0e20433827ef3ea88e074578ca95`
- **Format:** merged pull request

## Summary

Closes #253 and #254 — the two HITL slices of PRD #244. Implemented HITL-style on a branch (primary stayed on `main`); please review the merge-path change before merging.

## #253 — base resolution honors the branch lock (lock > pin > main)
`resolve_pinned_branch` now reads the primary checkout's branch-lock value (`.red/tmp/branch-lock.yaml`, via the branch-lock skill's `lock_store_read`) and resolves through `base_resolve` (ADR 0031). Locked → worktrees branch off + merge target the locked branch; unlocked → pin, then `main` (unchanged). lock-store is sourced from the sibling branch-lock skill (co-shipped in the dev plugin) behind a guard, so a partial install reads as unlocked. Adds `afk_is_locked()`.

## #254 — lock-toggled landing (ADR 0030)
`do_merge` branches on `afk_is_locked`:
- **locked** → merge `--no-ff` directly into the local locked branch + push origin. Nothing reaches `main`; promotion is the operator's. (Conflict-resolve + push-rollback unchanged.)
- **unlocked** → `land_pr`: force-push the attempt's final state, open/reuse a PR `--base {base} --head afk/{id}/{N}-slug`, `gh pr merge --admin --merge`. The PR is the durable per-attempt history (survives branch deletion). Local base is fast-forwarded to the merge commit for the closing envelope's `merge_sha`. Any PR-step failure → `ready-for-human`.

## Tests
- `base-lock-wiring.test.sh` (8) — locked / locked-over-pin / pinned / default / empty-lock + `afk_is_locked`.
- `lock-toggled-landing.test.sh` (15) — locked routing (direct merge+push, no PR), unlocked routing (push→PR→admin-merge→ff), idempotent PR reuse, admin-merge failure propagation.
- Full afk suite: **50/53 green**. The 3 reds (`fleet-runner-portability`, `lifecycle-on-session-error`, `statusline` case1) are pre-existing on `main`, unrelated.

## Docs
SKILL.md per-issue loop steps 2/8/9 (lock>pin>main + the two landing paths); `contexts/dev/CONTEXT.md` Branch-lock term + relationships.

Branch developed in a worktree; primary checkout stayed on `main` throughout.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/261"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782693310&installation_id=129708444&pr_number=261&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F261&signature=384e0984197a6f95455d374da4b6b1ef53f78c6bb2955c52f3db48af0471f5ab"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): base resolution honors the branch lock (lock > pin > main)…
- feat(afk): lock-toggled landing — admin-merged PR (unlocked) / local …

## Files changed

- `.red/contexts/dev/CONTEXT.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/base-lock-wiring.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lock-toggled-landing.test.sh`

