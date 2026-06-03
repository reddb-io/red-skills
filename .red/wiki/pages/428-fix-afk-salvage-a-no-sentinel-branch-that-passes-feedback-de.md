---
title: fix(afk): salvage a no-sentinel branch that passes feedback (Defeito 2 / issue #332)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-428]
pr: 428
merge_sha: 09235f46b9be6bf7aa1b6bda7ec2e2ea9f96fb1a
---

# fix(afk): salvage a no-sentinel branch that passes feedback (Defeito 2 / issue #332)

- **PR:** [#428](https://github.com/reddb-io/red-skills/pull/428)
- **Author:** @filipeforattini
- **Merge SHA:** `09235f46b9be6bf7aa1b6bda7ec2e2ea9f96fb1a`
- **Format:** merged pull request

## Summary

## The runtime cure for the no-sentinel loop

Diagnosed live on **#300**: the inner agent finished + committed at iteration 1, but exited without `<promise>DONE</promise>`; the runtime read EOF as a crash and re-invoked it (iter 1→4/20, ~50 min), never closing — even though the branch was mergeable the whole time. Dominant cause of AFK slowness.

## Fix (`process-issue.ts`)

On `run.outcome === "no-sentinel"`:
- **Empty branch** (no diff vs base, or absent) → unchanged: `on_attempt_error` + terminal `no-sentinel` (keeps the crash-retry budget).
- **Branch ahead of base + present** → **salvage**: skip `on_attempt_error`, fire `post_attempt(success)`, route through the **same feedback gate + landing + close tail the DONE path uses**. Feedback failure → `feedback-failed` (accurate), never `no-sentinel`. A salvaged attempt lands/closes exactly like DONE.

Contained restructure — no big extraction; both DONE and salvaged-no-sentinel enter the shared land tail, timeout/blocked still return early.

## Why it's safe

The feedback gate (typecheck/tests, ADR 0008) is load-bearing — only complete, green work lands. No-work / failing branches keep today's terminal failure path.

## Pairs with

- **#427** (merged) — `AGENT-PROMPT`: "already done still requires the sentinel" (the prevention). This PR is the cure.
- Re-implements the stale **#335** (~169 commits behind, pre-`src/apps`) on the current tree. #335 can be closed in favour of this.

## Tests / record

- `process-issue.test.ts` **52/52** — 3 new salvage cases (empty→terminal, work+green→done, work+fail→feedback-failed) + crash-retry tests pinned to `changedFiles:[]`.
- typecheck clean.
- **ADR 0047** records the decision (avoids the reserved 0043 / planned 0046).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/428"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783080898&installation_id=129708444&pr_number=428&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F428&signature=7f929c64c411e0d34f8b65b86498f642ec989885efcd75bb2359c71f235f890c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

## Release Notes

* **New Features**
  * Enhanced handling of incomplete runs: when a branch contains actual work changes, the system now salvages and completes those attempts through standard workflows instead of treating them as terminal failures.

* **Documentation**
  * Added architectural documentation detailing runtime safety improvements for handling incomplete work scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): salvage a no-sentinel branch that passes feedback instead o…

## Files changed

- `.red/adr/0047-afk-salvages-no-sentinel-branch-that-passes-feedback.md`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/tests/process-issue.test.ts`

