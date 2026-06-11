---
title: fix(afk): init the red-castle submodule in the feedback-gate worktree (landing blocker)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-720]
pr: 720
merge_sha: f03ab4ed1a4daaadcd5491f1403ed084326f9ac1
---

# fix(afk): init the red-castle submodule in the feedback-gate worktree (landing blocker)

- **PR:** [#720](https://github.com/reddb-io/red-skills/pull/720)
- **Author:** @filipeforattini
- **Merge SHA:** `f03ab4ed1a4daaadcd5491f1403ed084326f9ac1`
- **Format:** merged pull request

## Summary

## What a live fleet-of-2 exposed
A worker did **correct** work on #583 (4 focused commits, "1262 tests pass, tsc clean") but the orchestrator parked it **blocked:validation**. The gate's `validation.jsonl` failed every check — `test`/`typecheck`/`build` — all with `Cannot find module '@reddb-io/red-castle'`.

## Two environments, one confusion
- **CI/CD is fine** — `actions/checkout` uses `submodules: recursive` + `pnpm install`, so red-castle is present (the #719 `test` job is green).
- **The AFK feedback gate is different** — it materialises its own checkout with **`git worktree add`** (`feedback-worktree.ts`). A fresh git worktree does **NOT** populate submodules: `packages/red-castle` (the `@reddb-io/red-castle` `workspace:*` SOURCE, ADR 0061) is an **empty dir**. The `pnpm install` that follows can't resolve that workspace dep → every gate check fails → a **false blocked:validation** that stranded the entire PRD #567 fix cluster.

This is **not** the supervisor OOM (#446 — fixed; the gate test ran in 44ms not 42s) and **not** CI.

## Fix
Run `git submodule update --init --recursive` in the worktree **between `worktreeAdd` and `pnpm install`** — the convenience CI's `actions/checkout submodules:recursive` gives for free that a local `git worktree add` does not. Fails closed like the install step (#458/#459 precedent). Lives in the **dev plugin** (`apps/dev/src/runtime/feedback-worktree.ts`); red-castle untouched.

## Validation
- typecheck clean; feedback-worktree (11) + feedback (14) tests green, including a new submodule-init-failure test. Happy-path ordering is now `add → submodule → install → script`.
- Real proof comes once released: re-run a worker on a PRD #567 fix and watch it LAND instead of parking blocked:validation.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/720"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783811860&installation_id=129708444&pr_number=720&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F720&signature=e78cbe47701693e81ae177875b8d879173e8802c14f0931f753e5dca67d1e4c2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Improved handling of submodule initialization during development environment setup
  * Setup now properly fails and cleans up when module initialization encounters errors, preventing partial or incomplete states

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): init the red-castle submodule in the feedback-gate worktree…

## Files changed

- `apps/dev/src/runtime/feedback-worktree.ts`
- `apps/dev/tests/feedback-worktree.test.ts`

