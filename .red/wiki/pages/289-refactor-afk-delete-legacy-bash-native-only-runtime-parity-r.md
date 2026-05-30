---
title: refactor(afk): delete legacy bash, native-only runtime + parity recovery + zero-dep logger
type: source
tags: [pr, merged]
created: 2026-05-30
updated: 2026-05-30
sources: [pr-289]
pr: 289
merge_sha: 6e3960aec205da10ea5442ad8b7ab63c039111dc
---

# refactor(afk): delete legacy bash, native-only runtime + parity recovery + zero-dep logger

- **PR:** [#289](https://github.com/reddb-io/red-skills/pull/289)
- **Author:** @filipeforattini
- **Merge SHA:** `6e3960aec205da10ea5442ad8b7ab63c039111dc`
- **Format:** merged pull request

## Summary

Finishes the refactor: the legacy orchestration shell is **deleted** (86 .sh) and the native TS bundle is the only runtime — after recovering full feature parity so nothing is lost.

- **Parity recovery (PRD #287):** stale claim-lock sweep, legacy work-* wipe, merge-conflict one-shot self-resolve, worker env passthrough denylist, supervisor slots forward --prd/--issues/runner-policy, per-slot build isolation (hook defaults dir FIXED), continuous push #191 restored via sandcastle host.onWorktreeReady.
- **Native statusline command** added (the last bash-only surface) before deleting statusline.sh.
- **Bash deleted:** scripts/ (afk.sh, supervisor.sh, monitor.sh, statusline.sh, lib/*.sh + 59 bash tests). Kept defaults/ (live hook scripts) + detectors/ + examples/. Stripped runLegacy/RED_AFK_LEGACY. Bundle grep proof: bash refs = 0.
- **Zero-dep logger** (src/shared/log.ts, createLogger) — +1.0 KB vs pino's hundreds of KB.

646 dev tests; tsc clean; native monitor/reap/statusline/run all work.

[skip release] — native agent path still pending E2E (sandcastle agents) before a client release. Machine-local note: update .claude/settings.json statusLine to `node bin/afk.mjs statusline`.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/289"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782760872&installation_id=129708444&pr_number=289&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F289&signature=6c8a12ba31ece0244554a197102659e767d939c3dceceff7d346a8011f2261b4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): full native parity with bash before shell removal (PRD #287)
- refactor(afk): delete the legacy orchestration bash; native is the on…

## Files changed

- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `plugins/dev/skills/engineering/afk/scripts/afk-reap.sh`
- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/config.sh`
- `plugins/dev/skills/engineering/afk/scripts/hooks.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/agent-lane.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/attempt-ledger.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/attempt-reader.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/base-resolver.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/branch-ref.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/capabilities.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/envelope.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/heartbeat.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/history.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/hook-config.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/hook-dispatcher.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/inner-shims/pnpm`
- `plugins/dev/skills/engineering/afk/scripts/lib/jsonl-log.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/merge.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/mirror.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/pin-reader.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/reaper-signal.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/remote-branch.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/state.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/worker-paths.sh`
- `plugins/dev/skills/engineering/afk/scripts/monitor.sh`
- `plugins/dev/skills/engineering/afk/scripts/once.sh`
- `plugins/dev/skills/engineering/afk/scripts/statusline.sh`
- `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/agent-lane.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/attempt-ledger.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/attempt-reader.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/base-lock-wiring.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/base-resolver.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/branch-ref-guard.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/capabilities.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/comment-classifier.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/completion-sweep.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/config-loader.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/detectors.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/envelope-module.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/envelope-shape.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/feedback-package-scope.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/claude-final-blocked.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/claude-final-done.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/claude-mention-only.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/codex-banner-final-done.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/codex-final-done.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/codex-mention-only.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/history/buckets.jsonl`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/state/v1-full.json`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/state/v1-legacy-no-diff-fields.json`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/state/v1-malformed.json`
- `plugins/dev/skills/engineering/afk/scripts/tests/fixtures/state/v1-missing-current.json`
- `plugins/dev/skills/engineering/afk/scripts/tests/fleet-runner-portability.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/handoff-builder.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/heartbeat-loop.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/history-module.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/hook-config.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/hook-dispatcher.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/hooks-orchestrator.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/jsonl-log.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-attempt-rename.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks-executed.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-on-idle.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-on-session-error.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-post-attempt-on-error.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-post-merge.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-post-pick.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-post-session.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-pre-worktree-pre-attempt.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/local-branch-cleanup.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lock-toggled-landing.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/memory-attempt.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/merge-integrate.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/mirror-codex-sink.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/mirror.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/on-demand-reaper.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/per-issue-cap.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/pin-reader.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/pnpm-shim.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/reaper-signal.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/remote-branch.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/remote-live-branch-cleanup.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/restart-informed-retry.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/runner-detection.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/sentinel-detection.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/snapshot-grace-cleanup.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/split-teardown.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/stall-agent-lane.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/stall-detector.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/stall-reaper.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/state-accessor.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/statusline.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/sup-kill-tree.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/supervisor-hooks.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/trip-sweep.test.sh`

