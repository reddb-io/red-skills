---
title: refactor: monorepo (src/domains + shared + per-plugin bundles + dynamic fetch) + functionality recovery
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-06-06
sources: [pr-288]
pr: 288
merge_sha: 84a62af40769f473cf4425e61cb83ab8ad5ee042
---

# refactor: monorepo (src/domains + shared + per-plugin bundles + dynamic fetch) + functionality recovery

- **PR:** [#288](https://github.com/reddb-io/red-skills/pull/288)
- **Author:** @filipeforattini
- **Merge SHA:** `84a62af40769f473cf4425e61cb83ab8ad5ee042`
- **Format:** merged pull request

## Summary

Completes the monorepo restructure (ADR 0034) **and** the functionality-loss recovery (PRD #287).

## Restructure (ADR 0034)
- Historical note: this PR used the original `src/domains/{dev,memory}` wording.
  ADR 0034 now records the implemented tree as `src/apps/{dev,memory}`; the
  definition/implementation split is unchanged.
- `src/apps/{dev,memory}` = implementation; `plugins/*` = definition only;
  shared implementation code belongs under top-level `src/`.
- One minified bundle per artifact under `dist/`: `dev.bundle.min.mjs`, `memory.bundle.min.mjs` (+ memory-mcp, red-curate-skill), `code-nav-mcp.bundle.min.mjs` — shipped as GitHub Release assets, fetched dynamically by a best-effort SessionStart hook.
- code-nav MCP moved into the reorg + bundled + fetched like the rest.
- Skills reframed to "run the bundle with these params + agent-facing behaviour" (no implementation citations); `RED_AFK_LEGACY=1` documented as the transition shell fallback.

## Current ADR record (2026-06-06)

ADR 0034 remains accepted for the dev implementation split under `src/apps/dev`.
It is partially superseded by ADR 0039 for fused entrypoints and by ADR 0041 for
memory moving out of red-skills into `red-memory`.

## Functionality recovery (PRD #287 — a 3-front audit found real losses)
- **A — AFK live wiring un-stubbed**: config+hooks, attempt-ledger, branch-lock (ADR 0031), comments→handoff, prior-attempt+markers (#255), feedback against the agent worktree, `--request`, boot sweeps, diffstat+iter-log — were dormant despite passing unit tests.
- **B — lost features re-implemented**: `--alternate` + `--fallback-runner` + RUNNER_EXHAUSTED + **exit-75**; base→sandcastle (`branchStrategy.baseBranch`); session-level hooks.
- **C — memory regressions fixed**: 2 broken tests, hook-coverage fallback, all 3 entrypoints bundled.

**591 dev tests** (was 543) + memory tsc clean; all bundles build; `monitor`/`reap` native.

## Merging with `[skip release]`
No client release fires — the native AFK agent path + memory graph mode are **not E2E-validated** (need real sandcastle agents + the red binary). Transition fallbacks keep everything working. The deliberate client release is gated on that validation.

## Still tracked (genuinely blocked on sandcastle API)
Continuous per-commit push (#191), baseBranch best-effort on retries — see #287. Memory runtime + E2E validation — #286/#284.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/288"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782757513&installation_id=129708444&pr_number=288&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F288&signature=326b4c1cc262dfae783749cdfa50ab52529c57678d493208e5282dd41735c06e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(repo): move dev plugin impl to src/domains/dev + per-plugin …
- refactor(repo): move memory plugin impl to src/domains/memory + per-p…
- ci(release): point red-release at src/domains/{dev,memory} after the …
- feat(repo): shared layer (cli-args-parser) + dynamic plugin-bundle fe…
- chore: gitignore vitest .vite cache (stray-committed under src/shared)
- fix(afk,memory): recover functionality lost in the port/pivot/restruc…
- refactor(dev): move code-nav MCP into the reorg + bundle outside the …
- feat(afk): recover the lost runner-fallback subsystem + base resoluti…
- docs(skills): reframe to binary+params; ci: publish memory-mcp + cura…

## Files changed

- `.github/workflows/red-release.yml`
- `.gitignore`
- `.red/adr/0034-monorepo-src-domains-with-per-plugin-bundles.md`
- `CHANGES.md`
- `README.md`
- `packages/afk/package.json`
- `packages/afk/pnpm-workspace.yaml`
- `packages/afk/src/commands/run.ts`
- `packages/afk/tests/run-flags.test.ts`
- `packages/afk/vitest.config.ts`
- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/.mcp.json`
- `plugins/dev/hooks/claude.hooks.json`
- `plugins/dev/mcp/code-nav/dist/index.js`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/bin/README.md`
- `plugins/dev/skills/engineering/afk/detectors/README.md`
- `plugins/dev/skills/engineering/afk/runner-codex.md`
- `plugins/dev/skills/engineering/afk/runner-hermes.md`
- `plugins/dev/skills/engineering/context/SKILL.md`
- `plugins/memory/README.md`
- `plugins/memory/package.json`
- `src/domains/dev/.gitignore`
- `src/domains/dev/mcp/code-nav/.gitignore`
- `src/domains/dev/mcp/code-nav/README.md`
- `src/domains/dev/mcp/code-nav/package.json`
- `src/domains/dev/mcp/code-nav/pnpm-lock.yaml`
- `src/domains/dev/mcp/code-nav/pnpm-workspace.yaml`
- `src/domains/dev/mcp/code-nav/src/config.ts`
- `src/domains/dev/mcp/code-nav/src/index.ts`
- `src/domains/dev/mcp/code-nav/src/lsp.ts`
- `src/domains/dev/mcp/code-nav/tsconfig.json`
- `src/domains/dev/package.json`
- `src/domains/dev/pnpm-lock.yaml`
- `src/domains/dev/pnpm-workspace.yaml`
- `src/domains/dev/src/cli.ts`
- `src/domains/dev/src/commands/fleet.ts`
- `src/domains/dev/src/commands/monitor.ts`
- `src/domains/dev/src/commands/reap.ts`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/src/commands/supervise.ts`
- `src/domains/dev/src/core/attempt-ledger.ts`
- `src/domains/dev/src/core/attempt-reader.ts`
- `src/domains/dev/src/core/base-resolver.ts`
- `src/domains/dev/src/core/boot-sweep.ts`
- `src/domains/dev/src/core/boot.ts`
- `src/domains/dev/src/core/branch-cleanup.ts`
- `src/domains/dev/src/core/capabilities.ts`
- `src/domains/dev/src/core/comment-classification.ts`
- `src/domains/dev/src/core/config.ts`
- `src/domains/dev/src/core/envelope-emit.ts`
- `src/domains/dev/src/core/envelope.ts`
- `src/domains/dev/src/core/execution.ts`
- `src/domains/dev/src/core/feedback.ts`
- `src/domains/dev/src/core/handoff.ts`
- `src/domains/dev/src/core/heartbeat.ts`
- `src/domains/dev/src/core/history.ts`
- `src/domains/dev/src/core/hook-config.ts`
- `src/domains/dev/src/core/hook-dispatcher.ts`
- `src/domains/dev/src/core/jsonl-log.ts`
- `src/domains/dev/src/core/merge.ts`
- `src/domains/dev/src/core/mirror.ts`
- `src/domains/dev/src/core/monitor.ts`
- `src/domains/dev/src/core/pin-reader.ts`
- `src/domains/dev/src/core/process-issue.ts`
- `src/domains/dev/src/core/reaper-signal.ts`
- `src/domains/dev/src/core/reclaim.ts`
- `src/domains/dev/src/core/remote-branch.ts`
- `src/domains/dev/src/core/runner-detection.ts`
- `src/domains/dev/src/core/runner-spawn.ts`
- `src/domains/dev/src/core/session.ts`
- `src/domains/dev/src/core/state.ts`
- `src/domains/dev/src/core/statusline.ts`
- `src/domains/dev/src/core/supervisor.ts`
- `src/domains/dev/src/core/worker-paths.ts`
- `src/domains/dev/src/platform/command.ts`
- `src/domains/dev/src/platform/legacy.ts`
- `src/domains/dev/src/runtime/exec.ts`
- `src/domains/dev/src/runtime/feedback-worktree.ts`
- `src/domains/dev/src/runtime/fs.ts`
- `src/domains/dev/src/runtime/gh.ts`
- `src/domains/dev/src/runtime/git.ts`
- `src/domains/dev/src/runtime/hooks.ts`
- `src/domains/dev/src/runtime/lock.ts`
- `src/domains/dev/src/runtime/proc-tree.ts`
- `src/domains/dev/src/runtime/supervisor-fs.ts`
- `src/domains/dev/src/runtime/wire.ts`
- `src/domains/dev/src/types/runner.ts`
- `src/domains/dev/src/types/state.ts`
- `src/domains/dev/tests/attempt-ledger.test.ts`
- `src/domains/dev/tests/attempt-reader.test.ts`
- `src/domains/dev/tests/base-resolver.test.ts`
- `src/domains/dev/tests/boot-sweep.test.ts`
- `src/domains/dev/tests/boot.test.ts`
- `src/domains/dev/tests/branch-cleanup.test.ts`
- `src/domains/dev/tests/capabilities.test.ts`
- `src/domains/dev/tests/cli-routing.test.ts`
- `src/domains/dev/tests/cli.test.ts`
- `src/domains/dev/tests/comment-classification.test.ts`
- `src/domains/dev/tests/config.test.ts`
