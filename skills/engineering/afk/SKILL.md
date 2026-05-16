---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a PRD, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--prd N | --issues N,N,N] [--runner claude|codex] [-n N] [--once] [--slot N]"
---

# /afk

Drain the agent-ready backlog. Single skill that owns issue selection, worktree isolation, inner-agent execution, GitHub state coordination, merge-back, and runner-fallback.

## When To Use

- `/afk` — every issue currently labelled `ready-for-agent`.
- `/afk --prd 42` — only issues that reference PRD #42 (by `prd: #42` line in body, parent link, or `prd:42` label).
- `/afk --issues 356,359,362` — explicit list, in that order.
- `/afk --runner codex` — pin a backend instead of alternating on exhaustion.
- `/afk -n 5` — cap at five issues (default: drain until empty).
- `/afk --once` — single supervised iteration. Same as `scripts/once.sh`. Use for debugging the prompt.
- `/afk --slot 2` — run a second parallel worker (slot `1` is the default). Each slot owns its own log, pid, state file, and worktree path prefix.
- `/afk monitor` — readonly status board, aggregates every `.red/tmp/afk-*.state.json` so you see all live slots from another terminal.

## Slot & Parallelization

`/afk` is single-instance **per slot**. Slot defaults to `1`. To run N workers in parallel, launch each in its own terminal/tmux pane with a distinct `--slot`:

```bash
/afk --slot 1            # terminal A
/afk --slot 2            # terminal B
/afk --slot 3            # terminal C
```

Each slot writes its own files under `.red/tmp/`:

| Per-slot file | Purpose |
|---|---|
| `afk-{slot}.pid` | PID lockfile. Refuse to start a second `/afk --slot N` while this is live; treat as stale if the PID no longer exists. |
| `afk-{slot}.log` | Append-only run log. `/afk monitor` and `tail -F` read it. |
| `afk-{slot}.state.json` | The state schema described in *State File* below. |
| `../.workspaces/{repo}-s{slot}-{N}` | Per-issue worktree. Slot in the path so two slots working different issues never collide on filesystem. |

Two slots cannot claim the same issue because the GitHub label transition (`ready-for-agent` → `running`) is atomic — the second `gh issue edit` fails and that slot skips to the next candidate. No extra coordination needed.

Single-slot use (no `--slot` flag) is unchanged: everything still lands at `afk-1.*`.

## Hard Preconditions

Refuse to start if any of these fail. The user fixes them, you don't.

- `git remote -v` shows only SSH remotes. Reject HTTPS — never auto-rewrite.
- `gh auth status` succeeds.
- Repo has a `main` branch and `git -C primary log -1 main` works.
- Issue tracker label `ready-for-agent` exists. If not, point at `/triage`.
- `pnpm` is on PATH (logger and tooling guidelines assume pnpm).

## Bootstrap

Run before the first iteration:

1. Ensure `.red/tmp/` exists. Create it.
2. Ensure `.red/tmp/` is in `.gitignore` of the primary checkout. Append if missing.
3. Resolve the slot. Order: `--slot` flag > env `AFK_SLOT` > `1`. Slot is a positive integer; reject anything else. All per-run file paths below interpolate `{slot}`.
4. **Acquire the PID lock.** If `.red/tmp/afk-{slot}.pid` exists, read the PID. If `kill -0 $pid` succeeds (process alive), refuse to start — print "slot {slot} is already running (pid $pid). Use --slot N for a parallel worker." and exit 1. If the process is gone, treat the file as stale, log "reclaiming stale pid file for slot {slot}", and continue. Write the current `$$` to `afk-{slot}.pid` atomically.
5. **Open the log.** All orchestrator output (header excluded) tees into `.red/tmp/afk-{slot}.log`. Append-only, never truncate. Rotation is the user's job.
6. Initialise `.red/tmp/afk-{slot}.state.json` with the schema in *State File* below. Atomic write.
7. Resolve the runner. Order: `--runner` flag > env `AFK_RUNNER` > `claude`. Load [`runner-claude.md`](runner-claude.md) or [`runner-codex.md`](runner-codex.md) so the spawn command is ready.
8. Read [`SAFETY.md`](SAFETY.md). It is binding for every shell action the loop takes.
9. Install signal handlers — SIGINT, SIGTERM, and normal exit all remove `.red/tmp/afk-{slot}.pid` and release any in-flight issue claim before terminating.

## Straggler Check

Before issue selection, `/afk` counts open issues in states it cannot consume:

- `unlabeled` — never triaged
- `needs-triage` — triage in progress
- `needs-info` — waiting on reporter

If any of those are non-zero, print a warning and (on a TTY, not in `--once`) prompt to confirm before proceeding. This catches the "issue perdida" case where a fresh report never made it through `/triage` and is silently invisible to `/afk`.

The systemic fix is the `red-issues-needs-triage.yml` workflow installed by `/setup-red-skills`, which auto-applies `needs-triage` to every fresh issue. The straggler check is the in-loop safety net for repos where the workflow isn't installed yet.

## Issue Selection

Pull the candidate list with `gh issue list --label ready-for-agent --state open --json number,title,labels,body --limit 100`.

Apply filters in this order:

1. If `--issues` was passed: keep only those numbers, in argument order. Error if any are missing or not labelled `ready-for-agent`.
2. Else if `--prd` was passed: keep issues with `prd: #N` in the body, a parent link to issue N, or a `prd:N` label.
3. Else: keep all `ready-for-agent` issues. Sort by triage priority — `priority:high` before `priority:low` (and unlabelled), then by issue number ascending.

If the list is empty, print `<promise>NO MORE TASKS</promise>` and exit 0.

## Issue Lifecycle (the `/afk` slice)

Canonical state machine lives in [`setup-red-skills/triage-labels.md`](../setup-red-skills/triage-labels.md). The portion `/afk` touches:

```
  ready-for-agent
         │
   (1) claim
   remove ready-for-agent
   add running
   post start comment
         │
         ▼
      running
   ┌───┴───┐
   │       │  heartbeat sub-shell posts :one: → :four: every 10 min
   │       │
   │       │  inner agent works in worktree → emits DONE | BLOCKED
   │       │  orchestrator runs feedback loops, then merges to main
   │       │
   │       ├──── DONE + green + merged + pushed
   │       │           │
   │       │      (4a) close
   │       │      remove running
   │       │      gh issue close --reason completed
   │       │           │
   │       │           ▼
   │       │        closed
   │       │
   │       └──── BLOCKED, or merge conflict, or both runners exhausted
   │                   │
   │              (4b) release
   │              remove running
   │              add ready-for-human
   │              post blocker comment with worktree path
   │                   │
   │                   ▼
   │              ready-for-human  (worktree preserved at moment of blocker)
   │
   └──── orchestrator interrupted (SIGINT/SIGTERM)
                     │
                (4c) release
                remove running
                restore ready-for-agent
                post interruption comment
                     │
                     ▼
                ready-for-agent  (next /afk run can pick it up)
```

Label transitions are atomic via `gh issue edit --remove-label A --add-label B`. Two parallel `/afk` runners cannot both claim the same issue because the second attempt to remove `ready-for-agent` fails and that branch is skipped.

## Per-Issue Loop

For each issue `N`:

1. **Claim.** `gh issue edit N --remove-label ready-for-agent --add-label running`. Comment a start line: ISO timestamp, runner identity, worktree path. If labelling fails because someone else already claimed it, skip to the next issue.
2. **Worktree.** `git -C primary fetch origin main` then `git worktree add ../.workspaces/{repo}-s{slot}-{N} -b afk/s{slot}/{N}-{slug} origin/main` from the primary checkout. The branch is local-only until push. The `{slot}` segment keeps two parallel slots from colliding on filesystem.
3. **Drop file.** Materialise the AGENT-BRIEF into `{worktree}/.red/tmp/drop-{N}-{slug}.md` using the template below. Create `.red/tmp/` and append it to the worktree's `.gitignore` first if needed.
4. **Heartbeat.** Spawn a background sub-shell that posts `:one:`, `:two:`, `:three:`, `:four:` every 10 min (reset after `:four:`). Track PID in the state file so cleanup can kill it.
5. **Inner agent.** Invoke claude/codex per [`runner-*.md`](runner-claude.md) with [`AGENT-PROMPT.md`](AGENT-PROMPT.md) + the drop file + last 5 commits of `main`. Stream stdout into the loop's header tail. Detect stages by grep on the stream — see *Stage Detection* below.
6. **Inner result.**
   - Inner committed and emits `<promise>DONE</promise>` → continue to feedback loops.
   - Inner emits `<promise>BLOCKED</promise>` plus notes appended to the drop file → comment the blocker on the issue, re-label `ready-for-human`, kill heartbeat, drop the worktree, go to next issue.
   - Inner emits `<promise>NO MORE TASKS</promise>` from inside one iteration → ignored. That sentinel is for the outer loop.
   - Runner-exhausted signal (rate limit / quota error string per runner) → kill heartbeat, keep the worktree, swap runner, retry the same issue once. If both runners exhaust, exit 75 (`EX_TEMPFAIL`).
7. **Feedback loops.** In the worktree: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`. Any missing script: skip it and note in the validation comment. Any failure: re-enter the inner agent with the failure output appended to the drop file's Notes. Cap at 2 retries before marking blocked.
8. **Merge.**
   - Primary dirty? Auto-stage and commit `chore(afk): pre-merge snapshot for #N` in primary. Never `git stash`. Never `git checkout -- .`.
   - `git -C primary merge --no-ff afk/{N}-{slug} -m "merge: #{N} {title}"`.
   - Conflict? Try a one-shot self-resolve: re-enter the inner agent with the conflict diff and `git status` as context, instructing it to fix conflicts in primary, then `git commit`. On still-conflicting: abort with `git merge --abort`, comment the diff on the issue, re-label `ready-for-human`, move on.
9. **Push.** `git -C primary push origin main` over SSH. Failure → comment, re-label `ready-for-human`, move on. Do not retry-loop indefinitely.
10. **Close.** Validation comment on the issue: tests pass/fail, lint, typecheck, build, commits added, files touched. Then `gh issue close N --reason completed`. Remove `running` label.
11. **Cleanup.** `git worktree remove ../.workspaces/{repo}-s{slot}-{N}` and `git branch -D afk/s{slot}/{N}-{slug}` (the branch is already merged into main).
12. **Tick.** Update state file. Recompute ETA from rolling average of last 3 issue durations. Print one summary line: `finished {done}/{total} ({pct}%) — next: #{next}`.

## Runner Fallback

Default behaviour is to alternate runners between issues (claude first, codex second, claude third, …) so the loop tolerates a single-runner outage without manual intervention. Override with `--runner` to pin one backend.

Exhaustion detection lives in [`runner-claude.md`](runner-claude.md) and [`runner-codex.md`](runner-codex.md) — they own the per-runner error strings. The orchestrator only sees `RUNNER_EXHAUSTED` as a structured signal.

When swap happens mid-issue, the same worktree and drop file are reused; the new runner sees the previous agent's Notes appended.

## Heartbeat Protocol

Background sub-shell, per-issue lifetime. State machine:

```
t=0   → claim comment
t=10  → :one:
t=20  → :two:
t=30  → :three:
t=40  → :four:
t=50  → :one:   (reset)
...
```

Implementation: `(while sleep 600; do gh issue comment N --body "$(next_glyph)"; done) &`, PID saved to state. Killed on issue completion or blocker.

The terminal header has its own independent heartbeat counter (3 s tick) — see *Live Header* below. Don't conflate the two.

## Stage Detection

Inner agent stages, detected from stdout stream of the runner:

| stage | signal |
|-------|--------|
| setup | first output line |
| explore | `git ls-files`, `find`, repeated `Read` |
| impl | first `Edit`/`Write` call |
| tests | `pnpm test` invocation |
| commit | `git commit` invocation |
| merge | orchestrator stage, post-inner |
| push | orchestrator stage |
| close | orchestrator stage |

Each transition writes to state file. The monitor renders the current stage.

## Live Header

Redraw every 3 s on the controlling TTY, top of the scroll buffer. Use `tput sc; tput cup 0 0; …; tput rc` so the inner agent's stream below stays intact.

```
┌─ /afk ────────────────────────────────────────────────────┐
│ runner: codex          elapsed: 00:14:23   eta: ~01:20:00 │
│ done: 3 / 12 (25%)     blocked: 0          merged: 3      │
│                                                            │
│ ▶ #142 wire OAuth callback                                 │
│   worktree: ../.workspaces/red-skills-142                  │
│   stage: impl              heartbeat: :two:                │
│   last: writing tests for callback handler                 │
│                                                            │
│ queue: #143 #144 #145 #146 ...                             │
└────────────────────────────────────────────────────────────┘
```

If stdout is not a TTY (CI, piped log), skip header rendering and print one JSON line per state transition to stderr.

## State File

Path: `.red/tmp/afk-{slot}.state.json` (default slot `1` → `afk-1.state.json`). Schema:

```json
{
  "version": 1,
  "slot": 1,
  "pid": 12340,
  "log": ".red/tmp/afk-1.log",
  "started_at": "2026-05-16T12:00:00-03:00",
  "runner": "codex",
  "filter": { "kind": "prd|issues|all", "value": "42" },
  "total": 12,
  "done": 3,
  "failed": 0,
  "blocked": 0,
  "completed": [139, 140, 141],
  "queue": [143, 144, 145, 146],
  "current": {
    "number": 142,
    "title": "wire OAuth callback",
    "slug": "wire-oauth-callback",
    "worktree": "../.workspaces/red-skills-s1-142",
    "drop": ".red/tmp/drop-142-wire-oauth-callback.md",
    "started_at": "2026-05-16T12:14:00-03:00",
    "stage": "impl",
    "heartbeat_glyph": ":two:",
    "heartbeat_pid": 12345,
    "runner": "codex",
    "retries": 0,
    "last_stream_line": "writing tests for callback handler"
  },
  "durations_seconds": [820, 940, 760]
}
```

Atomic write: write to `afk-{slot}.state.json.tmp`, `mv` over the original. `/afk monitor` and any other reader open it read-only.

## Monitor

`/afk monitor` is the readonly aggregated view across all slots. It:

1. Globs `.red/tmp/afk-*.state.json` and renders one section per live slot.
2. Verifies liveness via the matching `afk-{slot}.pid` — files whose PID is dead are flagged `stale` and not counted as running.
3. Optionally tails `.red/tmp/afk-{slot}.log` for the most recent line under each slot's header.

Single-slot operation looks identical to the previous behaviour (one section, one heartbeat). Multi-slot adds one section per active worker, in slot order, plus an aggregate `done / total` summary across all slots.

## Drop File Template

`.red/tmp/drop-{N}-{slug}.md`:

```markdown
# Issue #{N} — {title} [AFK]

source: {gh-url}
prd: {prd-url-or-issue-ref}        # omit if none
runner: {claude|codex}
started: {iso8601}
attempt: {1..}

## Brief
{AGENT-BRIEF body from triage, verbatim}

## Acceptance
- [ ] {extracted from AGENT-BRIEF}

## Refs
- ADRs: {paths from brief, e.g. docs/adr/0007-foo.md}
- Wiki: {pages from brief, if any}
- PRD: {path or URL}

## Notes
{inner agent appends progress, blockers, decisions here across attempts}
```

The drop file follows the same minimalism as the `handoff` skill — reference artifacts by path, do not duplicate their content.

## Stop Conditions

- Queue drained → `<promise>NO MORE TASKS</promise>` → exit 0.
- `-n N` reached → summary + exit 0.
- Both runners exhausted → exit 75.
- Uncaught error in orchestrator → kill heartbeat, leave worktree in place, exit 1, print recovery hint.

## Reporting

After every issue, print:

```
✓ #142 wire OAuth callback   12m 14s   tests:✓ lint:✓ types:✓ build:✓   merged b3f2a91
finished 4 / 12 (33%) — next: #143
```

After the loop, a final block:

```
/afk done.
runner    : codex (3 issues), claude (1 issue)
duration  : 01:14:22
processed : 4 closed, 0 blocked, 0 failed
remaining : 8 still ready-for-agent
```

## Safety

See [`SAFETY.md`](SAFETY.md). The orchestrator and the inner agent both inherit those rules. Violations abort the loop.

## Source Of Truth

This skill is the single source of truth for autonomous execution in red-skills repos.
