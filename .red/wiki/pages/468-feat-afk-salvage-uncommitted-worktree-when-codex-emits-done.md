---
title: feat(afk): salvage uncommitted worktree when codex emits DONE without committing
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-468]
pr: 468
merge_sha: 376a7fff208fca792cb8a8be022aa7891baed2a8
---

# feat(afk): salvage uncommitted worktree when codex emits DONE without committing

- **PR:** [#468](https://github.com/reddb-io/red-skills/pull/468)
- **Author:** @filipeforattini
- **Merge SHA:** `376a7fff208fca792cb8a8be022aa7891baed2a8`
- **Format:** merged pull request

## Summary

## Problem (observed live on #301, codex runner)

While testing `/afk --runner codex`, codex did genuinely good work on #301 (5 files, ~196 lines, focused tests + typecheck green, even caught a governance edge case) — then emitted `<promise>DONE</promise>` **without ever running `git commit`**. AGENT-PROMPT step 5 requires one-commit-per-file before the sentinel, but codex left everything uncommitted in the worktree.

Consequence: sandcastle's "Collecting commits" found **0 commits** → the worker branch sat at base (zero commits ahead) → the DONE path runs the feedback gate against an empty changed-file set (vacuous pass) and lands an empty merge. The issue stayed OPEN and the 196-line diff was stranded in the soon-to-be-GC'd sandcastle worktree.

The existing no-sentinel salvage (ADR 0047 / #332) does **not** catch this: it keys off `changedFiles(branch, base) > 0`, but an uncommitted branch carries no commits.

## Fix

A best-effort `salvageUncommitted` port, invoked from `processIssue` when `runAgent` returns **zero commits** on a `done` or `no-sentinel` outcome:

1. `worktreePathForBranch` resolves the worktree checked out on the worker branch via `git worktree list --porcelain`.
2. If that worktree is dirty, commit **each changed path on its own commit** (the AGENT-PROMPT discipline), then `push --force-with-lease`.
3. The existing feedback gate + landing tail then validate and merge the real work — no special-casing downstream.

A clean worktree salvages nothing (count 0) → **today's behaviour is unchanged**. The port is optional, so legacy callers/tests are unaffected. This is a safety net under codex's prompt non-compliance, not a substitute — the agent should still commit.

## Files
- `runtime/git.ts` — `worktreePathForBranch` + `salvageUncommitted` (routed through the testable `runGit` seam)
- `core/process-issue.ts` — `salvageUncommitted?` dep + guarded invocation (`commits.length === 0`)
- `commands/run.ts` — wire the real git-backed port
- `runner-codex.md` — document the non-compliance + the salvage net

## Tests
- 11 new `runtime-git-branch` unit tests (worktree resolution, one-commit-per-file, rename dest, clean no-op, custom remote, push refspec)
- 4 new `process-issue` integration tests (zero-commit DONE salvages + lands + closes; DONE-with-commits never salvages; no-sentinel + clean stays terminal; legacy no-port unchanged)
- Full `src/apps/dev` suite green: **934/934**, typecheck clean

## Notes
- Not merged by me — flagged for review; a fleet was running during this session and `red-release` gates on `fleet.running == 0`.
- An ADR (extending the salvage decision to the DONE-without-commit case) may be warranted — happy to add if you want it tracked.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/468"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783110466&installation_id=129708444&pr_number=468&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F468&signature=63831b2721993478b34c9cec23461d0e2e8aee4702dfb65a225089c01fb1cb2f"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Bug Fixes**
  * Detects when an agent finishes without commits and automatically salvages uncommitted changes so they are committed and pushed for normal integration.

* **Documentation**
  * Added docs and an ADR describing the commit-leftovers salvage safety-net and when it runs.

* **Tests**
  * Expanded test coverage for the salvage flow and the new worktree/git behaviors.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): salvage uncommitted worktree when the inner agent emits DO…
- docs(adr): 0050 — AFK salvages an uncommitted worktree on DONE-withou…

## Files changed

- `.red/adr/0050-afk-salvages-uncommitted-worktree-on-done-without-commit.md`
- `.red/adr/INDEX.md`
- `plugins/dev/skills/engineering/afk/runner-codex.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/src/runtime/git.ts`
- `src/apps/dev/tests/process-issue.test.ts`
- `src/apps/dev/tests/runtime-git-branch.test.ts`

