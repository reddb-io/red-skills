---
title: docs(adr): 0043 — RedSkills teaches and enforces an interactive development loop
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-393]
pr: 393
merge_sha: c3550c798c44a538f3f89e4685764c4255642945
---

# docs(adr): 0043 — RedSkills teaches and enforces an interactive development loop

- **PR:** [#393](https://github.com/reddb-io/red-skills/pull/393)
- **Author:** @filipeforattini
- **Merge SHA:** `c3550c798c44a538f3f89e4685764c4255642945`
- **Format:** merged pull request

## Summary

ADR recording the decision from a `/start` grilling session.

## Decision
`/setup-red-skills` gains a **Section H** that ties together three pieces of an interactive development loop:

1. **Enforce** — extend `git-guardrails`/`branch-lock` (no parallel hook) to block the *agent* from switching the primary checkout's branch, unconditionally, gated by a config kill-switch `dev.lock-primary-branch`. Ships **dormant at the plugin level**; Section H turns it on. `git commit` is *not* blocked — emphasis is on not changing branches.
2. **Teach** — inject a `## Development workflow` block into `AGENTS.md`/`CLAUDE.md` (doctor parity-checked).
3. **Orchestrate** — new `/ship` skill: the interactive finalizer (worktree work → PR → monitor CI+reviews → approve+merge if green & no blocking review, else comment + `ready-for-human` + stop for `/dev:hitl`).

## Relationships
- **Refines ADR 0006** — keeps enforcement agent-only + the `work-*/` exemption; changes activation from lock-file-present to config-flag.
- **Relates to ADR 0030/0031** — `/ship` is the review-respecting sibling of `/afk`'s admin-merge landing. **AFK is unchanged and does not call `/ship`.**
- **Depends on ADR 0042** — `.red/config.yaml` `dev.*` keys.

## Next
Implementation is sliced in a follow-up PRD (`/to-prd` → `/to-issues` → `/afk`).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/393"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783011099&installation_id=129708444&pr_number=393&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F393&signature=e9b6b568eb4591e0fcda939808ff3f9d4c15953902b1c0ed6815e0ac07c0a66a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Documentation**
  * Added ADR documenting an interactive human-in-the-loop development loop and updated agent guidance with a new "Development workflow" section and parity checks.

* **New Features**
  * Added `/ship` dev skill to finalize work: open/reuse PRs, monitor CI/reviews with time caps, merge when protections pass or pause for human review.
  * Introduced an opt-in primary-branch lock (config flag, default off) that prevents automated branch switching while still allowing commits.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(adr): 0043 — RedSkills teaches and enforces an interactive devel…

## Files changed

- `.red/adr/0043-redskills-teaches-and-enforces-an-interactive-development-loop.md`

