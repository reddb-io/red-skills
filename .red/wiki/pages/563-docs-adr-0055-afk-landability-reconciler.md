---
title: docs(adr): 0055 — AFK landability reconciler
type: source
tags: [pr, merged]
created: 2026-06-08
updated: 2026-06-08
sources: [pr-563]
pr: 563
merge_sha: 33c75dd3145f815b652fccafb7bd305a0c8a9f8f
---

# docs(adr): 0055 — AFK landability reconciler

- **PR:** [#563](https://github.com/reddb-io/red-skills/pull/563)
- **Author:** @filipeforattini
- **Merge SHA:** `33c75dd3145f815b652fccafb7bd305a0c8a9f8f`
- **Format:** merged pull request

## Summary

Proposes **ADR 0055 — landability reconciler**: replace AFK's one-shot terminal routing with reconciliation toward a landability invariant, so a parked-but-green `afk/*` branch self-lands (validate → land) without re-running the agent.

**Proven empirically this session:** #407 and #456 both finished green+committed but were parked by the progress guard (`blocked:stalled`). Manually applying the reconcile (validate branch → admin-merge if green) landed both — PRs #559/#560 — recovering ~2h of work with zero agent re-run. The ADR makes that automatic via a no-agent reconcile worker mode, dispatched from three triggers (terminal-inline / boot-sweep / supervisor tick), scoped to mechanical blocker classes only.

Slices: #557 (prompt), #558 (reconcile worker-mode, core), #561 (boot-sweep), #562 (supervisor dispatch).

Status: **Proposed** — review vehicle. Generalises ADR 0047/0050.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/563"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783538075&installation_id=129708444&pr_number=563&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F563&signature=f14c9e6e2dfb79ac23aecac699075b70248781d813105e6a792b3346baa8f652"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated architectural documentation describing system improvements for handling parked work and self-healing mechanisms.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(adr): 0055 AFK landability reconciler
- Merge remote-tracking branch 'origin/main' into docs/adr-0055-landabi…
- docs(adr): renumber landability-reconciler 0055→0056 (resolve collisi…

## Files changed

- `.red/adr/0056-afk-landability-reconciler.md`
- `.red/adr/INDEX.md`

