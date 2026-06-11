---
title: feat(afk): run execution on the vendored @reddb-io/red-castle submodule (ADR 0061)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-674]
pr: 674
merge_sha: 116c9f3921e528e41a9300e79ec67ac1d85d3530
---

# feat(afk): run execution on the vendored @reddb-io/red-castle submodule (ADR 0061)

- **PR:** [#674](https://github.com/reddb-io/red-skills/pull/674)
- **Author:** @filipeforattini
- **Merge SHA:** `116c9f3921e528e41a9300e79ec67ac1d85d3530`
- **Format:** merged pull request

## Summary

Replaces the `@ai-hero/sandcastle` npm dependency with reddb.io's own fork, **vendored as a git submodule at `packages/red-castle`** (tracking `main`) and **consumed as TypeScript source** — no build of red-castle. esbuild (dev bundle) and tsx (dev runtime) compile its `src/*.ts` inline, the same way the dev bundle already inlined sandcastle's `dist`.

Companion red-castle PRs (merged): [#1](https://github.com/reddb-io/red-castle/pull/1) rename → `@reddb-io/red-castle` + exports→src, [#2](https://github.com/reddb-io/red-castle/pull/2) source type-clean for consumers, [#3](https://github.com/reddb-io/red-castle/pull/3) `build`→`build:dist` so consumers never auto-build. Submodule pinned at `34b5bfa`.

## Changes
- **`packages/red-castle`** — git submodule (`.gitmodules` `branch = main`), package `@reddb-io/red-castle`, `exports` → `./src/*.ts`.
- **`apps/dev`** — dep `@ai-hero/sandcastle ^0.6.5` → `@reddb-io/red-castle workspace:*`; `execution.ts` (the single seam, ADR 0033) + its test swap the import specifier. Nothing else was coupled.
- **root `package.json`** — `turbo build/test/typecheck` exclude `@reddb-io/red-castle` (vendored dep, not ours to build/gate).
- **`pnpm-workspace.yaml`** — `protobufjs` (via red-castle's unused `@daytona/sdk`) marked no-build.
- **CI** — `red-release`/`drift-guard`/`bench` checkout `submodules: recursive` so the workspace install resolves the package.
- **Docs** — ADR 0061 (refines 0033) + INDEX + 0033 status note + CLAUDE.md tree + the two live AFK skill docs.

## Verification
- `pnpm install` clean; `pnpm typecheck` green 6/6 and **does not build red-castle**
- `pnpm --filter @reddb-io/dev run bundle` → `dev.bundle.min.mjs` 1.4 MB, **0 `@ai-hero/sandcastle`**, effect inlined
- runtime: `import("@reddb-io/red-castle")` + `/sandboxes/{no-sandbox,docker}` resolve; `run`/`claudeCode`/`codex`/`opencode` are functions
- `execution.test.ts` 87/87

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/674"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783737915&installation_id=129708444&pr_number=674&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F674&signature=2b750152301f46b782e34af13d2b6e201ed37bb0a758a3457cfcb912763b13f1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): run execution on the vendored @reddb-io/red-castle submodu…

## Files changed

- `.github/workflows/red-memory-bench.yml`
- `.github/workflows/red-memory-drift-guard.yml`
- `.github/workflows/red-release.yml`
- `.gitmodules`
- `.red/adr/0033-afk-execution-runs-on-sandcastle.md`
- `.red/adr/0061-afk-runs-on-vendored-red-castle-submodule.md`
- `.red/adr/INDEX.md`
- `CLAUDE.md`
- `apps/dev/package.json`
- `apps/dev/src/core/execution.ts`
- `apps/dev/tests/execution.test.ts`
- `package.json`
- `packages/red-castle`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/runner-opencode.md`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

