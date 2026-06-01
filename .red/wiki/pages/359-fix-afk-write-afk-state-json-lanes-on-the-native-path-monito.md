---
title: fix(afk): write afk.state.json + lanes on the native path (monitor/statusline/stall-detector were blind)
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-359]
pr: 359
merge_sha: 95d9a43bbca9d8d96064d93468d1affaa268d2c9
---

# fix(afk): write afk.state.json + lanes on the native path (monitor/statusline/stall-detector were blind)

- **PR:** [#359](https://github.com/reddb-io/red-skills/pull/359)
- **Author:** @filipeforattini
- **Merge SHA:** `95d9a43bbca9d8d96064d93468d1affaa268d2c9`
- **Format:** merged pull request

## Summary

## What

Sibling of #350. The shell era's `iter_open` initialised `afk.state.json` and opened the JSONL lanes at claim. The TS port's run-path `ensureAttemptDir` is **mkdir-only**, so the native runtime wrote **neither** `afk.state.json` **nor** the `log.jsonl` firehose. The entire observability surface keys off that state file (+ the agent lane): `monitor` showed *no workers* for a live native worker, `statusline` rendered nothing, and the fleet stall-detector/reaper read a non-existent lane.

Confirmed live while supervising #334: the attempt dir held only `afk.log` + `handoff.md` — no `afk.state.json`, no `agent.log.jsonl`, no `log.jsonl`. `state.ts` (`initState`/`updateState`, fully tested) was **ported but never wired**.

## Fix (all in `run.ts` — IO layer; no `process-issue` control-flow change)

- **`buildProcessInput`** initialises `afk.state.json` at claim with the live orchestrator pid + `current.{number,title,worktree,handoff,started_at,stage}`.
- **`recordAgentEvent`** (the #350 sink) now also advances `current.stage`/`current.last_stream_line` via `deriveStage(event)` and appends the agent turn to the `log.jsonl` firehose.
- the **`processIssue` dep is wrapped** to mark the attempt not-live (`pid:0`) on return, guarded by `pathExists` so a DONE-swept dir is never resurrected.

`deriveStage` is a pure, exported, unit-tested mapping of a sandcastle stream event → pipeline stage (commit/tests/impl/explore). Best-effort throughout — a state-write failure never blocks a run.

## Validation

775 dev tests green (6 new `deriveStage` cases). Monitor visibility proven end-to-end against the rebuilt bundle: a state file with a live pid renders `wPROOF [live] … stage:impl`; `pid:0` flips it to `[stale]` (excluded from the live set). `bin/afk.mjs` rebuilt.

Refs #284.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/359"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782872520&installation_id=129708444&pr_number=359&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F359&signature=a8418b861256cd91aeb8ff15f83ae8f9a2292d474605cb668bfe0aca450775f2"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): write afk.state.json + lanes on the native path so monitor/…

## Files changed

- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/domains/dev/src/commands/run.ts`
- `src/domains/dev/tests/run-flags.test.ts`

