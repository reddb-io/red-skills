---
title: feat(brain): add the brain plugin (project-local knowledge repository)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-422]
pr: 422
merge_sha: ec7ec51ff155d2acc75bce03cbfb3f3a892c66f9
---

# feat(brain): add the brain plugin (project-local knowledge repository)

- **PR:** [#422](https://github.com/reddb-io/red-skills/pull/422)
- **Author:** @filipeforattini
- **Merge SHA:** `ec7ec51ff155d2acc75bce03cbfb3f3a892c66f9`
- **Format:** merged pull request

## Summary

## Status: DRAFT — review only, do **not** merge yet

Brings the **brain plugin** WIP forward onto current `main` (was sitting on a 20-commit-stale local checkout). Reconstructed cleanly — no clobber of the work that landed in those 20 commits.

## What's here

- **`plugins/brain/`** — `.claude-plugin` + `.codex-plugin` manifests (version parity ✓ 1.153.0), `.mcp.json` bootstrap launcher, hooks, README, and four core skills: `capture`, `search`, `think`, `status`.
- **`src/apps/brain/`** — TypeScript runtime (cli, mcp-server, store, schema, config, runtime, hash, hook-runtime) + tests. **Typechecks clean; 4/4 tests pass.** Joins the pnpm workspace via `src/apps/*`.
- **Registration** — brain entry in both marketplace manifests, README ("three plugins"), `CLAUDE.md` structure block, and a +6-line "Brain transport surfaces" note on the existing brain `CONTEXT.md`.

## What was deliberately NOT done

- **`.red/CONTEXT-MAP.md` untouched** — its brain section already landed on `main` via #409. Re-applying the stale local edit would have reverted it. Same reasoning kept me from snapshotting the stale `README.md`/`CONTEXT-MAP.md` — those were re-applied onto the current versions instead.
- **Not merged / not published** — the public marketplace is untouched; no release cut.

## ⛔ Pre-merge blockers (must resolve before this can land on `main`)

1. **Generated bundles in git.** `plugins/brain/dist-bundle/brain-mcp.mjs` (702KB) + `brain-cli.mjs` (76KB) = ~780KB of build output committed here for local testing. This **contradicts ADR 0038/0041** — `dev` and `memory` ship their runtime as a **fetched release asset** (only a ~6KB launcher is committed; the multi-MB bundle was deliberately purged from history). Migrate brain to the same fetch-launcher pattern before merging, or these bloat `main`'s permanent history.
2. **Stale version.** `1.153.0` vs the current `v1.156.0` line — the release version script (ADR 0040) rewrites on publish, but worth confirming.
3. **Publish-readiness.** brain is in-progress; confirm the four skills + MCP surface are ready to be public before the marketplace entry goes live.

## Context

The monitor diff-volume fix (#421) already shipped in **v1.156.0** — this PR is the separate "commit everything" half, parked as a draft per the decision to not publish brain yet.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/422"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783047058&installation_id=129708444&pr_number=422&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F422&signature=6074cd7c756f798ca2cc7c41a7730021d9b5d3d2e9b79c0a705383abf1dd419a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added Brain plugin for workspace-local knowledge management using a project database
  * Introduced four core skills: **capture** (store project knowledge), **search** (query artifacts), **think** (synthesize insights), and **status** (verify initialization)
  * Brain integrates with Claude Code and Codex plugins alongside existing dev and memory plugins

* **Documentation**
  * Updated README and plugin guides to reflect three-plugin architecture
  * Added Brain plugin documentation with connection string configuration and environment variable support

* **Chores**
  * Extended release automation to bundle Brain runtime alongside other plugin artifacts

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(brain): add the brain plugin (project-local knowledge repository)
- fix(brain): ship runtime as release assets, not committed bundles (AD…
- fix(brain): add brain package to pnpm-lock.yaml

## Files changed

- `.agents/plugins/marketplace.json`
- `.claude-plugin/marketplace.json`
- `.github/workflows/red-release.yml`
- `.gitignore`
- `.red/contexts/brain/CONTEXT.md`
- `CLAUDE.md`
- `README.md`
- `plugins/brain/.claude-plugin/plugin.json`
- `plugins/brain/.codex-plugin/plugin.json`
- `plugins/brain/.mcp.json`
- `plugins/brain/README.md`
- `plugins/brain/hooks/claude.hooks.json`
- `plugins/brain/hooks/codex.hooks.json`
- `plugins/brain/scripts/bootstrap.mjs`
- `plugins/brain/skills/core/README.md`
- `plugins/brain/skills/core/capture/SKILL.md`
- `plugins/brain/skills/core/search/SKILL.md`
- `plugins/brain/skills/core/status/SKILL.md`
- `plugins/brain/skills/core/think/SKILL.md`
- `pnpm-lock.yaml`
- `src/apps/brain/package.json`
- `src/apps/brain/src/cli.ts`
- `src/apps/brain/src/config.ts`
- `src/apps/brain/src/hash.ts`
- `src/apps/brain/src/hook-runtime.ts`
- `src/apps/brain/src/mcp-server.ts`
- `src/apps/brain/src/runtime.ts`
- `src/apps/brain/src/schema.ts`
- `src/apps/brain/src/store.ts`
- `src/apps/brain/tests/config.test.ts`
- `src/apps/brain/tsconfig.build.json`
- `src/apps/brain/tsconfig.json`
- `src/apps/brain/vitest.config.ts`

