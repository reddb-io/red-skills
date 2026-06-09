---
title: fix(afk): inner agent must not create PRs / wait on CI — commit + DONE only
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-605]
pr: 605
merge_sha: c095dd601f378ca4bbe8b43985962f5df83c352b
---

# fix(afk): inner agent must not create PRs / wait on CI — commit + DONE only

- **PR:** [#605](https://github.com/reddb-io/red-skills/pull/605)
- **Author:** @filipeforattini
- **Merge SHA:** `c095dd601f378ca4bbe8b43985962f5df83c352b`
- **Format:** merged pull request

## Summary

Live-observed runaway: a fleet worker did the #569 work, then **created its own PR (#603) and "waited for CI"** instead of emitting `<promise>DONE</promise>`. Because it never signalled DONE, the orchestrator stalled behind it; on re-invocation it opened a **second duplicate PR (#604)** for an issue that had meanwhile been landed and closed — so it ground an already-closed issue and littered dup PRs until the attempt guard would reap it.

Root cause: the AGENT-PROMPT said "the orchestrator owns the merge gate" but **never explicitly forbade** `gh pr create` / `gh pr merge` / `gh issue close` / CI-waiting on the inner agent (only the reddb run dodged it via an ad-hoc `-r` block).

**Fix:** add a binding rule to *What "Done" Means* in `AGENT-PROMPT.md` — the inner agent stops at commit + `DONE`; it must NOT run any land/PR/merge/close command and must NOT wait for/poll CI or external review checks. That surface is orchestrator mechanism that runs *after* the sentinel. Doc/contract only; recorded in CHANGES.md. Ships to workers on the next bundle release.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/605"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783616958&installation_id=129708444&pr_number=605&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F605&signature=2ed3ee69545bf806dc75d451fac080d50c89f42026c44a5b7018aaeaddb3a423"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Clarified explicit stopping conditions for agents: must stop after commit and emit completion signal, without creating PRs, managing CI, or polling external services.
  * Updated upstream divergence documentation.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): inner agent must not create PRs / wait on CI — commit + DON…

## Files changed

- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`

