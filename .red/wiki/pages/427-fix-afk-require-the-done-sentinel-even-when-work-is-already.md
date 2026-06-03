---
title: fix(afk): require the DONE sentinel even when work is already complete (Defeito 1)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-427]
pr: 427
merge_sha: 2cacbcf0fb156992c222eb1868732d260c79e9a8
---

# fix(afk): require the DONE sentinel even when work is already complete (Defeito 1)

- **PR:** [#427](https://github.com/reddb-io/red-skills/pull/427)
- **Author:** @filipeforattini
- **Merge SHA:** `2cacbcf0fb156992c222eb1868732d260c79e9a8`
- **Format:** merged pull request

## Summary

## Why
The dominant cause of AFK slowness (diagnosed live on #300): the inner agent finishes the work — or finds the branch *already* finished by a prior iteration — and exits **without `<promise>DONE</promise>`**. The runtime reads a sentinel-less exit as a crash and re-invokes the agent, burning iterations re-verifying an already-done commit. #300 looped iteration 1→4/20 over ~50 min; the work was complete at `7c1b285` since iteration 1.

## Fix
One paragraph in `AGENT-PROMPT.md`: **'already done' still requires the sentinel** — confirm acceptance criteria, then emit `DONE` (or `BLOCKED`). No silent nothing-to-do exit.

## Scope
Prevention half of the no-sentinel defect. The runtime **salvage** net (no-sentinel-but-green branch lands instead of being abandoned — issue #332, PR #335) is the complementary cure and lands next. Doc-only; ships on the next release bundle.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/427"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783080400&installation_id=129708444&pr_number=427&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F427&signature=d438eb7976e835f1c322e4b21ffdde7455ad98b52e35aa4f5bc8487b9d3ed8bb"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Enhanced system reliability by improving task completion signal handling to prevent unexpected errors during normal operations.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): require the DONE sentinel even when work is already complet…

## Files changed

- `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`

