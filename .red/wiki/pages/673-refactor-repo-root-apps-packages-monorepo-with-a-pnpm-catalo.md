---
title: refactor(repo): root apps/ + packages/ monorepo with a pnpm catalog (ADR 0060)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-673]
pr: 673
merge_sha: b3141f6e181cb7f088c70289ea15cc1473ecadec
---

# refactor(repo): root apps/ + packages/ monorepo with a pnpm catalog (ADR 0060)

- **PR:** [#673](https://github.com/reddb-io/red-skills/pull/673)
- **Author:** @filipeforattini
- **Merge SHA:** `b3141f6e181cb7f088c70289ea15cc1473ecadec`
- **Format:** merged pull request

## Summary

Relocates the Turborepo workspaces from `src/apps/*` + `src/packages/*` to the conventional root-level **`apps/*`** + **`packages/*`** (history-preserving `git mv`), and consolidates shared dependency versions into a pnpm **`catalog:`**. The ADR 0034 definitions/implementation split is unchanged — only the paths move.

## What changed
- **Layout:** `src/apps/* → apps/*`, `src/packages/* → packages/*`; empty `src/` removed.
- **Catalog:** `pnpm-workspace.yaml` gains a `catalog:` for versions shared by ≥2 workspaces (`typescript`, `tsx`, `vitest`, `esbuild`, `@types/node`, `zod`, `@modelcontextprotocol/sdk`). Apps reference them via `"catalog:"`.
  - `@reddb-io/sdk` is **deliberately not cataloged** — `bundle-app.mjs --reddb-from-package` reads the raw version string from `package.json`, and pnpm leaves the literal `"catalog:"` there, which would poison the embedded SDK version/binary tag. Kept pinned (`1.7.0`) in memory/brain/benchmark-memory.
  - `code-nav` keeps its higher `@types/node`/`esbuild` pins explicit.
- **Paths:** app→root relative paths shift `../../../ → ../../` across workspace `package.json` scripts, `turbo.json` outputs, and the release/bench/drift-guard CI workflows. app→packages paths are invariant.
- **Runtime/test resolution:** fixed root-resolution sites (memory `hook-coverage`, benchmark corpus dirs, the entrypoint bundle hint, brain `bootstrap.mjs`) and the doc/fixture test helpers (4-segment `..` joins → 3).
- **Docs/ADR:** reconciled CLAUDE.md, READMEs, affected dev SKILLs, the brain glossary, and the ADR INDEX; added **ADR 0060**; noted the relocation in ADR 0034's Status. Historical ADR bodies and wiki pages keep their text (append-only convention).
- **Cleanup:** removed the dead pre-ADR-0052 `dist-bundle/*` leftovers and their `turbo.json` output globs.

## Verification
- `pnpm install` ✅ (catalog resolved in lockfile)
- `pnpm typecheck` ✅ 6/6
- `pnpm build` ✅ — `afk.mjs`/`red-fetch.mjs` regenerate byte-clean (0 `src/apps`), `--reddb-from-package` intact
- `pnpm test` — all path/fixture tests pass. The `supervisor.test.ts` worker OOM is **pre-existing** (documented `#446`/heap issue): reproduces identically on unchanged `origin/main` (`31 passed (86)`), and no CI job runs the full vitest suite.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/673"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783733968&installation_id=129708444&pr_number=673&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F673&signature=b1c7971e81c1f736e97e2f470eb6adf18f04b2b7e47be6063a01db0f10d77168"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(repo): relocate workspaces to root apps/ + packages/ with a …

## Files changed

- `.github/workflows/red-memory-bench.yml`
- `.github/workflows/red-memory-drift-guard.yml`
- `.github/workflows/red-release.yml`
- `.red/adr/0034-monorepo-src-domains-with-per-plugin-bundles.md`
- `.red/adr/0060-root-apps-packages-with-pnpm-catalog.md`
- `.red/adr/INDEX.md`
- `.red/contexts/brain/CONTEXT.md`
- `CLAUDE.md`
- `README.md`
- `apps/benchmark-code-understanding/README.md`
- `apps/benchmark-code-understanding/package.json`
- `apps/benchmark-code-understanding/src/cli.ts`
- `apps/benchmark-code-understanding/src/corpus.ts`
- `apps/benchmark-code-understanding/src/report.ts`
- `apps/benchmark-code-understanding/src/runner.ts`
- `apps/benchmark-code-understanding/src/types.ts`
- `apps/benchmark-code-understanding/tests/cli.test.ts`
- `apps/benchmark-code-understanding/tests/report.test.ts`
- `apps/benchmark-code-understanding/tsconfig.json`
- `apps/benchmark-memory/package.json`
- `apps/benchmark-memory/src/cli.ts`
- `apps/benchmark-memory/tsconfig.json`
- `apps/brain/package.json`
- `apps/brain/src/auto-linker.ts`
- `apps/brain/src/brain-act.ts`
- `apps/brain/src/channel-bridge.ts`
- `apps/brain/src/cli.ts`
- `apps/brain/src/config.ts`
- `apps/brain/src/event-artifact-mapper.ts`
- `apps/brain/src/hash.ts`
- `apps/brain/src/hook-runtime.ts`
- `apps/brain/src/ingest-events.ts`
- `apps/brain/src/kpi-query.ts`
- `apps/brain/src/mcp-server.ts`
- `apps/brain/src/runtime.ts`
- `apps/brain/src/scheduled-ingestion.ts`
- `apps/brain/src/schema.ts`
- `apps/brain/src/store.ts`
- `apps/brain/tests/brain-act.test.ts`
- `apps/brain/tests/channel-bridge.test.ts`
- `apps/brain/tests/config.test.ts`
- `apps/brain/tests/event-artifact-mapper.test.ts`
- `apps/brain/tests/fixtures/fake-channel-bridge.ts`
- `apps/brain/tests/ingest-events.test.ts`
- `apps/brain/tests/kpi-query.test.ts`
- `apps/brain/tests/scheduled-ingestion.test.ts`
- `apps/brain/tests/store.test.ts`
- `apps/brain/tsconfig.build.json`
- `apps/brain/tsconfig.json`
- `apps/brain/vitest.config.ts`
- `apps/code-nav/.gitignore`
- `apps/code-nav/README.md`
- `apps/code-nav/package.json`
- `apps/code-nav/src/config.ts`
- `apps/code-nav/src/index.ts`
- `apps/code-nav/src/lsp.ts`
- `apps/code-nav/tsconfig.json`
- `apps/dev/.gitignore`
- `apps/dev/package.json`
- `apps/dev/src/cli.ts`
- `apps/dev/src/commands/activity-review.ts`
- `apps/dev/src/commands/dashboard.ts`
- `apps/dev/src/commands/fleet.ts`
- `apps/dev/src/commands/inject-development-workflow.ts`
- `apps/dev/src/commands/monitor.ts`
- `apps/dev/src/commands/reap.ts`
- `apps/dev/src/commands/retake.ts`
- `apps/dev/src/commands/route-model-tier.ts`
- `apps/dev/src/commands/run.ts`
- `apps/dev/src/commands/ship.ts`
- `apps/dev/src/commands/statusline.ts`
- `apps/dev/src/commands/supervise.ts`
- `apps/dev/src/core/activity-review.ts`
- `apps/dev/src/core/attempt-ledger.ts`
- `apps/dev/src/core/attempt-outcome.ts`
- `apps/dev/src/core/attempt-reader.ts`
- `apps/dev/src/core/attempt-record.ts`
- `apps/dev/src/core/backpressure.ts`
- `apps/dev/src/core/base-resolver.ts`
- `apps/dev/src/core/blocker-state.ts`
- `apps/dev/src/core/boot-sweep.ts`
- `apps/dev/src/core/boot.ts`
- `apps/dev/src/core/branch-cleanup.ts`
- `apps/dev/src/core/comment-classification.ts`
- `apps/dev/src/core/config.ts`
- `apps/dev/src/core/dashboard.ts`
- `apps/dev/src/core/development-workflow.ts`
- `apps/dev/src/core/envelope-emit.ts`
- `apps/dev/src/core/envelope.ts`
- `apps/dev/src/core/execution.ts`
- `apps/dev/src/core/feedback.ts`
- `apps/dev/src/core/handoff.ts`
- `apps/dev/src/core/heartbeat.ts`
- `apps/dev/src/core/history.ts`
- `apps/dev/src/core/hitl-decision-extraction.ts`
- `apps/dev/src/core/hitl-resolution-plan.ts`
- `apps/dev/src/core/hitl-selection.ts`
- `apps/dev/src/core/hook-config.ts`
- `apps/dev/src/core/hook-dispatcher.ts`
- `apps/dev/src/core/issue-classifier.ts`

