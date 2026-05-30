---
title: feat(afk): TypeScript runtime — committed bundle, release pipeline, 21 ported modules
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-282]
pr: 282
merge_sha: 010b276fdbe2a661d1898031f1024be6bfb63762
---

# feat(afk): TypeScript runtime — committed bundle, release pipeline, 21 ported modules

- **PR:** [#282](https://github.com/reddb-io/red-skills/pull/282)
- **Author:** @filipeforattini
- **Merge SHA:** `010b276fdbe2a661d1898031f1024be6bfb63762`
- **Format:** merged pull request

## Summary

## What this is

The foundation for shipping AFK as built TypeScript artifacts that run on client
machines, plus the bulk of the shell→TS port. Three goals advanced together:

### 1. Release model — ship a built, committed, dependency-free bundle (ADR 0032)
- TS source relocated **out of the skill directory** to the repo-root `packages/afk/`
  (outside the plugin tree → never ships to the client cache, never tempts an agent
  into reading code instead of running the skill).
- A single esbuild bundle (zod inlined) is built to the **committed**
  `plugins/dev/skills/engineering/afk/bin/afk.mjs`. It ships verbatim in the plugin
  cache and runs with a bare `node bin/afk.mjs <cmd>` — no node_modules, no install,
  no bootstrap. This deliberately diverges from the memory plugin's release-asset
  model (ADR 0029) to eliminate the **dist-noop trap**.
- `red-release.yml` rebuilds and commits the bundle in the version-bump commit, so
  the shipped artifact always matches the released source. Build is deterministic.

### 2. Reorg — steer the agent to run, not read
- "Run, don't read" banner + Runtime & Invocation section at the top of SKILL.md.
- `bin/README.md` marks the bundle as generated.
- End state (as bash retires): skill dir = SKILL.md + reference `*.md` + `bin/afk.mjs`.

### 3. Port — 21 core modules, tests-first, bash parity
Every pure/decidable subsystem of the skill is now ported with vitest, decision
logic kept pure over injectable IO (fs/git/gh/process):

- **leaf**: attempt-ledger, jsonl-log, history (byte-exact sparkline), pin-reader,
  base-resolver, capabilities, reaper-signal
- **mid**: config, remote-branch, merge (lock-toggled landing), mirror, heartbeat,
  monitor (compact render)
- **hooks/cleanup**: hook-config, hook-dispatcher (ADR 0026), branch-cleanup
- (pre-existing) runner-detection, state, worker-paths, envelope, attempt-reader

**252 vitest pass · typecheck clean · bundle rebuilds deterministically.**

## What remains (tracked separately)

The imperative orchestration capstone — `afk.sh` (the per-issue loop) and
`supervisor.sh` (the fleet) — still runs in bash; the bundle delegates to it via
`runLegacy`. Wiring the ported modules into a native orchestrator and retiring the
shell needs the consent-gated integration suite (real git worktrees / processes) to
validate, so it is **not** in this PR. A PRD covers it.

## Notes
- The bundle currently stays small because the ported modules are tested library
  code not yet wired into the CLI command graph — wiring is part of the capstone.
- No behavioural change to the live skill: bash remains the runtime; this PR adds the
  TS runtime alongside it and makes the bundle the entrypoint.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/282"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782736187&installation_id=129708444&pr_number=282&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F282&signature=365904109a6564bc63b777c82e18fb6ac7f955b01a61b3589c63370743d3adb2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * AFK now ships as a committed, dependency-free runtime bundle for immediate use.
  * Expanded CLI: run (more modes), monitor (compact dashboard), fleet/supervisor (start/stop/manage), reap and supervise commands.
  * Native supervisor/fleet management with background supervisor process, heartbeat/history logging, compact statusline, and richer run/session orchestration.
  * Built-in validation/feedback, handoff generation, and improved branch/attempt cleanup planning.

* **Documentation**
  * New ADRs and plugin runtime docs describing the bundle and execution model.

<!-- review_stack_entry_start -->

[![Review Change Stack](https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui.svg)](https://app.coderabbit.ai/change-stack/reddb-io/red-skills/pull/282?utm_source=github_walkthrough&utm_medium=github&utm_campaign=change_stack)

<!-- review_stack_entry_end -->
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): ship TS runtime as a committed dependency-free bundle (ADR…
- feat(afk): port 7 leaf orchestration modules to TypeScript (tests-first)
- feat(afk): port mid-tier modules to TypeScript (config, remote-branch…
- feat(afk): port lifecycle hooks + branch-cleanup classifiers to TypeS…
- feat(afk): port boot-sweep deciders + statusline render to TypeScript
- feat(afk): port capstone wave A — comment-classification, runner-spaw…
- feat(afk): port capstone wave B — handoff builder + boot orchestrator
- feat(afk): port capstone wave C — process-issue loop + fleet supervisor
- feat(afk): pivot execution to @ai-hero/sandcastle (ADR 0033)
- feat(afk): rewire process-issue onto the sandcastle execution backend
- feat(afk): port the outer session loop + issue selection (last orches…
- feat(afk): cut the CLI over to the native TS runtime (bundle no longe…
- fix(afk): supervisor pins --runner on spawned workers (legacy bash path)

## Files changed

- `.github/workflows/red-release.yml`
- `.red/adr/0032-afk-ships-as-a-committed-dependency-free-bundle.md`
- `.red/adr/0033-afk-execution-runs-on-sandcastle.md`
- `packages/afk/.gitignore`
- `packages/afk/package.json`
- `packages/afk/pnpm-lock.yaml`
- `packages/afk/pnpm-workspace.yaml`
- `packages/afk/src/cli.ts`
- `packages/afk/src/commands/fleet.ts`
- `packages/afk/src/commands/monitor.ts`
- `packages/afk/src/commands/reap.ts`
- `packages/afk/src/commands/run.ts`
- `packages/afk/src/commands/supervise.ts`
- `packages/afk/src/core/attempt-ledger.ts`
- `packages/afk/src/core/attempt-reader.ts`
- `packages/afk/src/core/base-resolver.ts`
- `packages/afk/src/core/boot-sweep.ts`
- `packages/afk/src/core/boot.ts`
- `packages/afk/src/core/branch-cleanup.ts`
- `packages/afk/src/core/capabilities.ts`
- `packages/afk/src/core/comment-classification.ts`
- `packages/afk/src/core/config.ts`
- `packages/afk/src/core/envelope-emit.ts`
- `packages/afk/src/core/envelope.ts`
- `packages/afk/src/core/execution.ts`
- `packages/afk/src/core/feedback.ts`
- `packages/afk/src/core/handoff.ts`
- `packages/afk/src/core/heartbeat.ts`
- `packages/afk/src/core/history.ts`
- `packages/afk/src/core/hook-config.ts`
- `packages/afk/src/core/hook-dispatcher.ts`
- `packages/afk/src/core/jsonl-log.ts`
- `packages/afk/src/core/merge.ts`
- `packages/afk/src/core/mirror.ts`
- `packages/afk/src/core/monitor.ts`
- `packages/afk/src/core/pin-reader.ts`
- `packages/afk/src/core/process-issue.ts`
- `packages/afk/src/core/reaper-signal.ts`
- `packages/afk/src/core/reclaim.ts`
- `packages/afk/src/core/remote-branch.ts`
- `packages/afk/src/core/runner-detection.ts`
- `packages/afk/src/core/runner-spawn.ts`
- `packages/afk/src/core/session.ts`
- `packages/afk/src/core/state.ts`
- `packages/afk/src/core/statusline.ts`
- `packages/afk/src/core/supervisor.ts`
- `packages/afk/src/core/worker-paths.ts`
- `packages/afk/src/platform/command.ts`
- `packages/afk/src/platform/legacy.ts`
- `packages/afk/src/runtime/exec.ts`
- `packages/afk/src/runtime/fs.ts`
- `packages/afk/src/runtime/gh.ts`
- `packages/afk/src/runtime/git.ts`
- `packages/afk/src/runtime/wire.ts`
- `packages/afk/src/types/runner.ts`
- `packages/afk/src/types/state.ts`
- `packages/afk/tests/attempt-ledger.test.ts`
- `packages/afk/tests/attempt-reader.test.ts`
- `packages/afk/tests/base-resolver.test.ts`
- `packages/afk/tests/boot-sweep.test.ts`
- `packages/afk/tests/boot.test.ts`
- `packages/afk/tests/branch-cleanup.test.ts`
- `packages/afk/tests/capabilities.test.ts`
- `packages/afk/tests/cli-routing.test.ts`
- `packages/afk/tests/cli.test.ts`
- `packages/afk/tests/comment-classification.test.ts`
- `packages/afk/tests/config.test.ts`
- `packages/afk/tests/envelope-emit.test.ts`
- `packages/afk/tests/envelope.test.ts`
- `packages/afk/tests/execution.test.ts`
- `packages/afk/tests/feedback.test.ts`
- `packages/afk/tests/handoff.test.ts`
- `packages/afk/tests/heartbeat.test.ts`
- `packages/afk/tests/history.test.ts`
- `packages/afk/tests/hook-config.test.ts`
- `packages/afk/tests/hook-dispatcher.test.ts`
- `packages/afk/tests/jsonl-log.test.ts`
- `packages/afk/tests/legacy.test.ts`
- `packages/afk/tests/merge.test.ts`
- `packages/afk/tests/mirror.test.ts`
- `packages/afk/tests/monitor.test.ts`
- `packages/afk/tests/pin-reader.test.ts`
- `packages/afk/tests/process-issue.test.ts`
- `packages/afk/tests/reaper-signal.test.ts`
- `packages/afk/tests/reclaim.test.ts`
- `packages/afk/tests/remote-branch.test.ts`
- `packages/afk/tests/run-flags.test.ts`
- `packages/afk/tests/runner-detection.test.ts`
- `packages/afk/tests/runner-spawn.test.ts`
- `packages/afk/tests/session.test.ts`
- `packages/afk/tests/state.test.ts`
- `packages/afk/tests/statusline.test.ts`
- `packages/afk/tests/supervisor.test.ts`
- `packages/afk/tests/wire.test.ts`
- `packages/afk/tests/worker-paths.test.ts`
- `packages/afk/tsconfig.build.json`
- `packages/afk/tsconfig.json`
- `packages/afk/vitest.config.ts`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/bin/README.md`

