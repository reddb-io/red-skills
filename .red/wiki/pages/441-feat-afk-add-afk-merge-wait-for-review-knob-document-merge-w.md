---
title: feat(afk): add afk.merge.wait_for_review knob + document merge-without-advice policy (#431)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-441]
pr: 441
merge_sha: e031ed9c928bf3af61cee6f6cf1d70781ae61367
---

# feat(afk): add afk.merge.wait_for_review knob + document merge-without-advice policy (#431)

- **PR:** [#441](https://github.com/reddb-io/red-skills/pull/441)
- **Author:** @filipeforattini
- **Merge SHA:** `e031ed9c928bf3af61cee6f6cf1d70781ae61367`
- **Format:** merged pull request

## Summary

Closes #431.

Makes the AFK **merge-without-advice** policy explicit and adds an opt-in to wait on an advisory reviewer. Today the unlocked admin-merge (`gh pr merge --admin --merge`) already ignores advisory review checks (CodeRabbit et al.) — `drift-guard` (the `pre_merge` hook) + the in-process feedback gate are the binding gates. This slice records that as intentional and adds the knob.

## What changed
- **config** (`config.ts`): `afk.merge.wait_for_review` (bool, default `false`) + `afk.merge.review_check` (default `CodeRabbit`), namespaced under `plugins.dev.afk.merge.*` with the legacy top-level fallback (ADR 0042).
- **merge.ts**: `waitForReviewCheck` polls `gh pr checks` until the named review check concludes; `landPr` calls it before the admin-merge when enabled, then merges regardless of the verdict (advisory). Fail-open — a missing/never-concluding reviewer never wedges the landing.
- **landing.ts / process-issue.ts / run.ts**: thread the opt-in from config to `landPr`; default off preserves current behaviour.
- **SKILL.md**: new "Merge-gate policy" note + the two config knobs.
- **ADR 0048** records merge-without-advice + in-process backpressure as the guardrail (refines ADR 0030/0008).

## Acceptance criteria
- [x] `afk.merge.wait_for_review` parsed (namespaced + legacy fallback), default `false`.
- [x] Default (`false`): unlocked admin-merge proceeds without waiting on advisory review (drift-guard still gates).
- [x] `true`: the unlocked landing waits for the configured review check before merging.
- [x] AFK `SKILL.md` documents the merge-gate policy + the knob.
- [x] An ADR records the merge-without-advice + backpressure-as-guardrail decision.
- [x] Tests cover the knob's effect on the landing decision (injected, no real network).
- [x] Commit carries a `Memory-NoIngest:` trailer (adds an ADR).

## Tests
Full `vitest run` suite green (848 tests). The targeted suites — `merge.test.ts`, `landing.test.ts`, `config.test.ts` (55 tests) — pass: `waitForReviewCheck` poll/terminal/timeout/absent, `landPr` wait-then-merge vs default no-poll, `doLanding` threading, and config parse (default + namespaced + legacy). Typecheck clean.

> Note: `supervisor.test.ts` emits a teardown-time "Worker exited unexpectedly" tinypool flake (it spawns real processes) — pre-existing and unrelated to this change; its 31 tests pass when run alone.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/441"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783086653&installation_id=129708444&pr_number=441&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F441&signature=5508ae73da775fd0e0bc687bb46619040c56cbc27abd7e16b6ecea658f4a337a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Optional configuration to have AFK admin merges wait for an advisory review check to conclude before merging; merges remain advisory (fail-open) and still respect in-process safety gates.

* **Documentation**
  * Added ADR documenting AFK merge policy and updated configuration reference with the new merge-wait settings.

* **Tests**
  * Added tests covering default behavior, config precedence, and review-check polling outcomes.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): add afk.merge.wait_for_review knob + document merge-withou…

## Files changed

- `.red/adr/0048-afk-merges-without-advice-backpressure-is-the-guardrail.md`
- `.red/adr/INDEX.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/src/core/landing.ts`
- `src/apps/dev/src/core/merge.ts`
- `src/apps/dev/src/core/process-issue.ts`
- `src/apps/dev/tests/config.test.ts`
- `src/apps/dev/tests/landing.test.ts`
- `src/apps/dev/tests/merge.test.ts`

