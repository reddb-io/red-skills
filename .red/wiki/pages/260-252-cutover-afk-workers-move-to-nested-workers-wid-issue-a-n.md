---
title: #252 cutover: AFK workers move to nested workers/{wid}/{issue}-a{n}/ + worker.pid
type: source
tags: [pr, merged]
created: 2026-05-29
updated: 2026-05-29
sources: [pr-260]
pr: 260
merge_sha: d4568411454d8f6d0fad44df1fd6d29383c241aa
---

# #252 cutover: AFK workers move to nested workers/{wid}/{issue}-a{n}/ + worker.pid

- **PR:** [#260](https://github.com/reddb-io/red-skills/pull/260)
- **Author:** @filipeforattini
- **Merge SHA:** `d4568411454d8f6d0fad44df1fd6d29383c241aa`
- **Format:** merged pull request

## Summary

Closes #252 (the HITL drain-first cutover slice of PRD #244).

## What this does
Switches the AFK on-disk scheme from the flat `.red/tmp/work-{id}-i{N}/` (per-iteration `afk.pid`) to the nested `.red/tmp/workers/{wid}/{issue}-a{n}/` attempt tree anchored by a single per-worker `worker.pid`.

This is **drain-first** (no dual-read, Q11c): boot wipes any legacy flat `work-*/` dirs unconditionally, then sweeps the nested tree. See ADR 0030 / 0031 on main.

## Changes
- **afk.sh (producer):** worker.pid written once at bootstrap + removed on EXIT trap; attempt dir built via `worker_paths_build` + `attempt_ledger_next_number` (per-issue-across-workers counter); drain-first `prune_orphans`. Also fixes a real arity bug — `attempt_ledger_next_number` takes `(root, issue)`, not the worker id.
- **6 consumers:** monitor, statusline, mirror, supervisor, state, orphan-cleanup re-globbed to `workers/*/*/`. Liveness now reads the state file's `.pid` (`state_is_live`) for monitor/statusline/mirror; supervisor slot matching keys off `workers/{wid}/worker.pid`.
- **worker-paths.sh:** `worker_paths_worker_dir`, `worker_paths_pidfile`, `worker_paths_live_pids_glob`.
- **Docs + glossary:** SKILL.md / SAFETY.md / AGENT-PROMPT.md / runner-*.md and `contexts/dev/CONTEXT.md` (new **Worker** + **Attempt** terms) describe the nested scheme.
- **Tests:** all fixtures migrated to the nested layout.

## Test status
44/47 green. The 3 reds (`fleet-runner-portability`, `lifecycle-on-session-error`, `statusline` case1) **fail identically on pristine `main`** — pre-existing, unrelated to this cutover.

Branch developed in a worktree; primary checkout stayed on `main` throughout.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/260"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782676987&installation_id=129708444&pr_number=260&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F260&signature=db846e9c9c2c06eb34e4a630b27ecffa4de3c9cc0632e42eea41cb2435efedd1"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): worker-paths pid/dir/live-pids helpers for #252 cutover
- feat(afk): orchestrator writes the nested workers/{wid}/{issue}-a{n} …
- feat(afk): migrate the six consumers + orphan-cleanup to the nested l…
- docs(afk): cut prose, glossary, and fixtures over to the nested layou…

## Files changed

- `.red/contexts/dev/CONTEXT.md`
- `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`
- `plugins/dev/skills/engineering/afk/SAFETY.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/runner-claude.md`
- `plugins/dev/skills/engineering/afk/runner-codex.md`
- `plugins/dev/skills/engineering/afk/scripts/afk.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/mirror.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/state.sh`
- `plugins/dev/skills/engineering/afk/scripts/lib/worker-paths.sh`
- `plugins/dev/skills/engineering/afk/scripts/monitor.sh`
- `plugins/dev/skills/engineering/afk/scripts/statusline.sh`
- `plugins/dev/skills/engineering/afk/scripts/supervisor.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/lifecycle-hooks-executed.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/mirror-codex-sink.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/mirror.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/stall-agent-lane.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/stall-detector.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/stall-reaper.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/statusline.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/trip-sweep.test.sh`
- `plugins/dev/skills/engineering/afk/scripts/tests/worker-paths.test.sh`

