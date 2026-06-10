---
title: fix(afk): CLI ergonomics and safety — no accidental worker launch, no read-command side effects
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-668]
pr: 668
merge_sha: 10baeee13034a2ac8337f1528fd4c82daa2f3732
---

# fix(afk): CLI ergonomics and safety — no accidental worker launch, no read-command side effects

- **PR:** [#668](https://github.com/reddb-io/red-skills/pull/668)
- **Author:** @filipeforattini
- **Merge SHA:** `10baeee13034a2ac8337f1528fd4c82daa2f3732`
- **Format:** merged pull request

## Summary

Fixes #589

## Summary

- **CLI guard**: `afk moniter` (typo'd subcommand) now errors with `UnknownCommandError` instead of silently draining the queue as a `run` invocation. New `RouterSchema.errorOnUnknownCommand` gate in shared router. Flag-led (`--prd …`) and empty invocations still reach `run` as before.
- **`--issues` validation**: an all-invalid value (zero finite numbers parsed) now throws `RunFlagError` instead of producing `{ numbers: [] }` and silently draining only urgents.
- **`monitor` side-effect-free**: the #407 recovery watchdog is now opt-in (`--watchdog` / `RED_AFK_WATCHDOG=1`). Read-only `monitor` invocations no longer tear down and relaunch a quiescent supervisor.
- **`ship` review wait**: waits for an in-flight advisory bot review (`afk.merge.review_check`, default CodeRabbit) to conclude before merging — parity with the AFK landing path. `--review-check NAME` / `--no-review-wait` control it. Fail-open, time-capped.
- **`deriveStage` classification**: file-tool name classification (read/grep/glob → explore, edit/write → impl) now wins over the loose `args 'test'` match, so reading a path containing `'test'` is no longer mislabeled as the `tests` stage.

## Tests

52 tests across `cli-routing`, `run-flags`, `ship`, `feedback-worktree` + 24 in shared `args` — all pass.

## Notes

Forward-port of worker w36PD's work on branch `afk/w36PD/589-fix-afk-cli-ergonomics-and-safety-no-acc`. The original branch had 33 commits of drift and conflicted with main; this cherry-picks the fix commit cleanly onto current main.

Closes #589

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/668"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783721109&installation_id=129708444&pr_number=668&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F668&signature=49c1043fd73c5ab9f31a799845ae66123cba4eb21c6fc68928acb6693827e435"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added `--review-check` and `--no-review-wait` flags for `/ship` command to control advisory bot review handling.
  * CLI now rejects mistyped subcommands with clear error messages.

* **Improvements**
  * Monitor watchdog is now opt-in via `--watchdog` flag (previously on by default).
  * Run command validates `--issues` input to prevent empty filters.
  * Improved tool classification for more accurate stage detection.

* **Documentation**
  * Updated `/ship` command documentation with new flag options.

* **Tests**
  * Added coverage for CLI routing, flag validation, and advisory review behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): CLI ergonomics and safety — no accidental worker launch, no…
- fix(shared): UnknownCommandError uses explicit props, not parameter p…

## Files changed

- `plugins/dev/skills/engineering/ship/SKILL.md`
- `src/apps/dev/src/cli.ts`
- `src/apps/dev/src/commands/monitor.ts`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/commands/ship.ts`
- `src/apps/dev/src/core/ship.ts`
- `src/apps/dev/tests/cli-routing.test.ts`
- `src/apps/dev/tests/run-flags.test.ts`
- `src/apps/dev/tests/ship.test.ts`
- `src/packages/shared/args.test.ts`
- `src/packages/shared/args.ts`

