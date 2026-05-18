---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a PRD, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--prd N | --issues N,N,N] [--runner claude|codex] [-n N] [--once] | fleet [N] | fleet stop | monitor"
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
- `/afk monitor` — readonly status board, aggregates every `.red/tmp/work-*/afk.state.json` so you see all live workers from another terminal.
- `/afk fleet [N]` — launch the supervisor (Claude Code only) maintaining `N` concurrent workers (default `2`). See *Fleet Mode* below.
- `/afk fleet stop` — gracefully shut down a running fleet supervisor and cancel its auto-monitor cron.

## Parallelization

`/afk` is **trivially parallel** — just open another terminal and run `/afk` again. No flag, no coordination, no slot to manage.

```bash
/afk            # terminal A → spawns worker "wZ2R4"
/afk            # terminal B → spawns worker "wK7M2"
/afk            # terminal C → spawns worker "w9RQP"
```

Each invocation generates its own **worker ID** — literal `w` plus 4 random characters from `[A-Z0-9]` (e.g. `wZ2R4`, ~1.7M possible IDs) — and uses it as the prefix for every per-run file. The leading `w` makes `work-w*-i*` an unambiguous glob for AFK iteration dirs. The ID is printed on the first line of the run so you can tail or kill it later.

Per-issue files live under `.red/tmp/work-{id}-i{N}/` in the primary checkout. Everything for one (worker, issue) iteration is in one directory — when the iteration ends successfully the whole directory is removed; when it blocks the whole directory is preserved.

| Path | Purpose |
|---|---|
| `.red/tmp/work-{id}-i{N}/worktree/` | Git worktree for issue `N`. Lives inside the gitignored `.red/tmp/` so it never pollutes sibling directories. |
| `.red/tmp/work-{id}-i{N}/afk.pid` | PID of the orchestrator. Used by `/afk monitor` to flag dead workers as `stale` via `kill -0`. Re-written on each iteration. |
| `.red/tmp/work-{id}-i{N}/afk.log` | Append-only log for this iteration. Per-issue scope — each issue gets a fresh log. |
| `.red/tmp/work-{id}-i{N}/afk.state.json` | State snapshot for this iteration. Schema in *State File* below. |
| `.red/tmp/work-{id}-i{N}/handoff.md` | Handoff file (AGENT-BRIEF) the inner agent reads. Template in *Handoff File Template* below. |

Two workers cannot claim the same issue thanks to a local `mkdir` lock at `.red/tmp/claims/{N}/` plus a `gh issue view` pre-check before the edit. The gh edit itself is not atomic (see *Issue Lifecycle* below for the full three-layer scheme). The race surface is the brief window between two separate checkouts on the same host — acceptable for the intended scale.

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
3. **Generate the worker ID.** Literal `w` + 4 random characters from `[A-Z0-9]` (e.g. `wZ2R4`). On the astronomically unlikely chance the chosen ID already maps to a live `.red/tmp/work-{id}-*/afk.pid`, regenerate. Print the ID on the first line of the run: `worker: {id}`. All per-iteration paths interpolate `{id}` and the issue number `{N}`.
4. Resolve the runner. Order: `--runner` flag > env `AFK_RUNNER` > `claude`. Load [`runner-claude.md`](runner-claude.md) or [`runner-codex.md`](runner-codex.md) so the spawn command is ready.
5. Read [`SAFETY.md`](SAFETY.md). It is binding for every shell action the loop takes.
6. Install signal handlers — SIGINT, SIGTERM, and normal exit all release any in-flight issue claim and preserve the active `work-{id}-i{N}/` directory before terminating.

The per-iteration `work-{id}-i{N}/` directory (pid, log, state, handoff, worktree) is created in *Per-Issue Loop* step 1 below, not here — the worker has no files until it claims an issue.

## Orphan Cleanup (boot-time)

Right after bootstrap and before *Straggler Check*, `/afk` sweeps `.red/tmp/work-*/` for orphaned iteration dirs (orchestrator pid dead). For each:

1. **Kill zombie heartbeat.** If the state file recorded `heartbeat_pid` and that sub-shell is still alive, `kill` it. Otherwise it would keep posting `:one: :two:` on the issue forever, consuming `gh` quota.
2. **Decide fate from issue state.** `gh issue view N --json labels,state`:
   - `state == CLOSED` → `rm -rf`. Work landed; nothing to inspect.
   - label `ready-for-human` → **split TTL** based on `envelope.posted` in the iteration state file (see *Terminal-Event Envelope* below):
     - `envelope.posted == true` → 1-day TTL. The issue thread already carries the canonical record; the local dir is pure redundancy.
     - `envelope.posted == false` or field missing → 7-day TTL. The envelope POST failed (or this dir predates the envelope writer), so the local notes/log are the only copy.
   - label `running` (orchestrator crashed mid-issue) → restore `ready-for-agent`, post a recovery comment, then `rm -rf`. Leaving the issue eternally `running` is worse than losing the dir.
   - any other state → `rm -rf`.
3. **Fallback on gh failure.** Network / rate-limit error → fall back to mtime TTL: 7 days for dirs with a state file, 1 day for dirs without one. Conservative enough to survive transient outages without losing artefacts the human wanted.

This removes the manual "remember to clean `.red/tmp/`" discipline. Blocker dirs persist until their TTL expires; everything else self-collects on the next `/afk` run.

## Unblock Sweep (boot-time)

After *Orphan Cleanup* and before *Straggler Check*, `/afk` scans every open issue labelled `ready-for-human` and checks whether its declared blockers have all closed. If yes, the issue is auto-promoted back to `ready-for-agent` for this run.

How the sweep works:

1. `gh issue list --label ready-for-human --state open --json number,body`.
2. For each candidate, extract refs (`#N`) under the literal `## Blocked by` heading in the body. Format is the GitHub task list emitted by `/to-issues`: `- [ ] #N` (one per line).
3. For each ref, `gh issue view <N> --json state`. Auto-promote only when **every** ref resolves to `state == CLOSED`. Checkbox state in the body is human UX — the lookup is the source of truth.
4. On promotion: `gh issue edit --remove-label ready-for-human --add-label ready-for-agent`, post an audit comment (`🤖 /afk promoted to ready-for-agent: all blockers closed (#X, #Y).`), and log a single orchestrator line `unblocked N issue(s): #A #B`.

Trade-off accepted: an issue may have hit `ready-for-human` for a reason unrelated to the listed blockers (test failure, spec ambiguity). Auto-promotion will then bounce it back to `ready-for-human` on the next attempt — cheap, and the fresh BLOCKED Notes the agent writes are more informative than stale ones.

## Straggler Check

Before issue selection, `/afk` counts open issues in states it cannot consume:

- `unlabeled` — never triaged
- `needs-triage` — triage in progress
- `needs-info` — waiting on reporter

If any of those are non-zero, print a warning and (on a TTY, not in `--once`) prompt to confirm before proceeding. This catches the "issue perdida" case where a fresh report never made it through `/triage` and is silently invisible to `/afk`.

The systemic fix is the `red-issues-needs-triage.yml` workflow installed by `/setup-red-skills`, which auto-applies `needs-triage` to every fresh issue. The straggler check is the in-loop safety net for repos where the workflow isn't installed yet.

## Issue Selection

Pull the candidate list with `gh issue list --label ready-for-agent --state open --json number,title,labels,body --limit 100`.

**PRD exclusion (hard).** Drop every issue carrying the `type:prd` label before any other filter. PRDs describe *what* to build, not an implementable slice — they must be split by `/to-issues` first. If a PRD is found in `ready-for-agent` (usually because someone labelled it manually), log a warning naming the issue numbers and the fix (`/to-issues N`), and continue with the remaining candidates. This defence is in addition to `/to-prd` never applying `ready-for-agent` in the first place.

**Urgent prepend (hard, runs before any filter).** Issues carrying `priority:urgent` always jump the head of the queue, ahead of `--prd` and `--issues` filters. Source: the `/urgent` skill files an issue with `priority:urgent` + `ready-for-agent`; every `/afk` invocation prepends those to the candidate list regardless of which selection flags were passed. Among urgents, oldest issue number first.

Apply filters to the **non-urgent remainder** in this order:

1. If `--issues` was passed: keep only those numbers, in argument order. Error if any are missing or not labelled `ready-for-agent`. PRDs in the explicit list are still rejected — the user is told to slice them first.
2. Else if `--prd` was passed: keep issues with `prd: #N` in the body, a parent link to issue N, or a `prd:N` label. The PRD itself (#N) is excluded by the `type:prd` filter above.
3. Else: keep all remaining `ready-for-agent` issues. Sort by triage priority — `priority:high` before `priority:low` (and unlabelled), then by issue number ascending.

The final queue is `[urgent…] + [filtered non-urgent…]`, deduped by number (so an urgent issue that also matched the filter only appears once, at the front).

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

Label transitions are **not** atomic at the gh level — `gh issue edit --remove-label A --add-label B` resolves the new label set client-side and submits the union, so a removed-but-no-longer-present label is a silent no-op and the edit returns 0. To prevent two parallel `/afk` runners from both thinking they claimed the same issue, the per-issue claim uses three layers:

1. **Local `mkdir` lock** at `.red/tmp/claims/{N}/` (POSIX-atomic). Workers in the same checkout race here, and the loser skips.
2. **Pre-check** via `gh issue view --json labels` — if `ready-for-agent` is already gone or `running` is already present, abort before the edit. Cuts the cross-checkout race window to roughly one round-trip.
3. **Stale-lock sweep** at boot, inside `prune_orphans` — any `.red/tmp/claims/{N}/` whose recorded pid is dead gets reclaimed automatically.

Residual gap: two clones of the same repo on the same host (or different hosts) do not share `.red/tmp/`, so each holds its own mkdir lock and the gh edit race re-opens for the brief window the pre-check leaves uncovered. Acceptable for the intended scale (a few terminals, one checkout). If you need cross-host claim safety, gate `/afk` on a proper coordinator instead of GitHub labels.

## Per-Issue Loop

For each issue `N`:

1. **Claim.** `gh issue edit N --remove-label ready-for-agent --add-label running`. Then create the iteration directory `.red/tmp/work-{id}-i{N}/` and write `afk.pid` (current `$$`), open `afk.log` (tee target for orchestrator output), and initialise `afk.state.json` per *State File* below. Comment a start line on the issue: ISO timestamp, runner identity, worktree path. If labelling fails because someone else already claimed it, abandon the iteration directory and skip to the next issue.
2. **Worktree.** `git -C primary fetch origin main` then `git worktree add .red/tmp/work-{id}-i{N}/worktree -b afk/{id}/{N}-{slug} origin/main` from the primary checkout. The branch is local-only until push. The worktree lives inside the gitignored `.red/tmp/` tree so it never appears in `git status` for `main`.
3. **Handoff file.** Materialise the AGENT-BRIEF into `.red/tmp/work-{id}-i{N}/handoff.md` using the template below. The handoff file lives one level above the worktree so the inner agent reads it via `../handoff.md` from inside the worktree, and so it survives a worktree wipe on retry.
4. **Heartbeat.** Spawn a background sub-shell that posts `:one:`, `:two:`, `:three:`, `:four:` every 10 min (reset after `:four:`). Track PID in the state file so cleanup can kill it.
5. **Inner agent.** Invoke claude/codex per [`runner-*.md`](runner-claude.md) with [`AGENT-PROMPT.md`](AGENT-PROMPT.md) + the handoff file + last 5 commits of `main`. Stream stdout into the loop's header tail. Detect stages by grep on the stream — see *Stage Detection* below.
6. **Inner result.**
   - Inner committed and emits `<promise>DONE</promise>` → continue to feedback loops.
   - Inner emits `<promise>BLOCKED</promise>` plus notes appended to the handoff file → comment the blocker on the issue, re-label `ready-for-human`, kill heartbeat, drop the worktree, go to next issue.
   - Inner emits `<promise>NO MORE TASKS</promise>` from inside one iteration → ignored. That sentinel is for the outer loop.
   - Runner-exhausted signal (rate limit / quota error string per runner) → kill heartbeat, keep the worktree, swap runner, retry the same issue once. If both runners exhaust, exit 75 (`EX_TEMPFAIL`).
7. **Feedback loops.** In the worktree: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`. Any missing script: skip it and note in the validation comment. Any failure: re-enter the inner agent with the failure output appended to the handoff file's Notes. Cap at 2 retries before marking blocked.
8. **Merge.**
   - Primary dirty? Auto-stage and commit `chore(afk): pre-merge snapshot for #N` in primary. Never `git stash`. Never `git checkout -- .`.
   - `git -C primary merge --no-ff afk/{N}-{slug} -m "merge: #{N} {title}"`.
   - Conflict? Try a one-shot self-resolve: re-enter the inner agent with the conflict diff and `git status` as context, instructing it to fix conflicts in primary, then `git commit`. On still-conflicting: abort with `git merge --abort`, comment the diff on the issue, re-label `ready-for-human`, move on.
9. **Push.** `git -C primary push origin main` over SSH. Failure → comment, re-label `ready-for-human`, move on. Do not retry-loop indefinitely.
10. **Close.** Validation comment on the issue: tests pass/fail, lint, typecheck, build, commits added, files touched. Then `gh issue close N --reason completed`. Remove `running` label.
11. **Cleanup.** `git worktree remove .red/tmp/work-{id}-i{N}/worktree`, `git branch -D afk/{id}/{N}-{slug}` (the branch is already merged into main), then `rm -rf .red/tmp/work-{id}-i{N}/` so the iteration leaves no trace. On blocker paths the directory is preserved for human inspection.
12. **Tick.** Update state file. Recompute ETA from rolling average of last 3 issue durations. Print one summary line: `finished {done}/{total} ({pct}%) — next: #{next}`.

## Runner Fallback

Default behaviour is to alternate runners between issues (claude first, codex second, claude third, …) so the loop tolerates a single-runner outage without manual intervention. Override with `--runner` to pin one backend.

Exhaustion detection lives in [`runner-claude.md`](runner-claude.md) and [`runner-codex.md`](runner-codex.md) — they own the per-runner error strings. The orchestrator only sees `RUNNER_EXHAUSTED` as a structured signal.

When swap happens mid-issue, the same worktree and handoff file are reused; the new runner sees the previous agent's Notes appended.

## Sentinel Watchdog

Failure mode observed in production: the inner agent emits `<promise>DONE</promise>` (or `BLOCKED`) but the orchestrator's stream-json pipe stays open for hours. Cause: a tool call the inner agent left running — typically `run_in_background` followed by a `bash -c 'until grep "test result" $out; do sleep 5; done'` polling loop without a timeout. The bg task crashes silently, the loop runs forever, the inner agent can't terminate because the tool call is still active, and the pipeline hangs.

The orchestrator now spawns a watchdog alongside every inner-agent pipeline (`run_sentinel_watchdog`). The watchdog tails the raw stream capture; once it sees `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`, it gives the pipeline `WATCHDOG_GRACE_SECONDS` (default 30) to close cleanly. If the pipeline is still alive at the deadline:

1. `kill_tree pid TERM` — recursively SIGTERM the pipeline pid and every descendant (claude / codex, jq, grep, tee, and any bash child stuck in a polling loop).
2. 5 s grace.
3. `kill_tree pid KILL` — SIGKILL anything still alive.

The orchestrator logs `watchdog: inner emitted sentinel but pipeline still open after Ns — killing tree (likely bash-hang from polling without timeout)` and proceeds with the captured result. The issue is closed normally because the agent's commit work, sentinel, and result are all already on disk by the time the watchdog fires.

Override the grace via `WATCHDOG_GRACE_SECONDS` in the orchestrator's env. Setting it lower than ~5 s risks killing healthy pipelines that just haven't flushed jq's buffer. 30 s is conservative.

Preventive counterpart lives in [`AGENT-PROMPT.md`](AGENT-PROMPT.md) under *Background Tasks and Polling* — inner agents are required to cap every polling loop with a deadline. The watchdog is the safety net; the prompt rule is the design.

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

## Terminal-Event Envelope

Every terminal event of an iteration posts **exactly one** structured comment on the issue. The comment is the canonical record of what the worker saw and did, and a future Slice C parser will reconstruct iteration history by walking these envelopes in a thread.

Statuses (one per envelope, mutually exclusive):

| `data-attempt-status` | trigger |
|---|---|
| `blocked` | inner agent emitted `<promise>BLOCKED</promise>` |
| `no-sentinel` | inner agent exited without `DONE` or `BLOCKED` |
| `merge-conflict` | orchestrator could not merge to `main` |
| `done` | success — merged, closing envelope |

Schema (deterministic — Slice C depends on this shape):

```html
<details data-attempt-status="blocked"><summary>worker `wZ2R4` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1</summary>

<details data-section="notes"><summary>notes</summary>

…handoff `## Notes` body…

</details>

</details>
```

Per-status body sections:

- `blocked` → one `data-section="notes"` block carrying the handoff's `## Notes` (the inner agent's appended progress/blockers).
- `no-sentinel` → both `data-section="notes"` (handoff Notes, may be empty placeholder) **and** `data-section="log"` (last 50 lines of the captured inner-agent stdout, fenced).
- `merge-conflict` → one `data-section="log"` block carrying the merge-conflict diff tail (last 50 lines of `git merge` output), fenced. Mirrors the no-sentinel log shape.
- `done` → no body sections. Summary carries `diff: merged` and `merge: ` `<sha>` (GitHub auto-links bare SHAs to the commit on `main`). The merge commit on `main` *is* the diff — no need to duplicate it inline.

Summary line is always `worker `{id}` · status: {status} · duration: NmSs · diff: {diff} · attempt: K [· merge: {sha}]`, where `{diff}` is `+N -M` against `origin/main` for non-DONE statuses and the literal `merged` for DONE.

After a successful POST (any 2xx), the orchestrator sets `envelope.posted: true` in the iteration state file. The boot-time *Orphan Cleanup* reads that field to pick a TTL for preserved `ready-for-human` dirs: 1 day when the envelope made it to the issue (the thread carries the canonical record), 7 days when the POST failed (the local dir is the only copy of the notes/log). The field is initialised `false` at iteration start.

What this envelope explicitly **does not** include (deferred to later slices):
- Heartbeat-glyph comments (`:one: :two: …`) — Slice D will replace those with a single, in-place edited heartbeat.
- Branch push to a remote `afk-attempts/` namespace — Slice B. Until then, the envelope's diffstat is computed against the local-only branch and the worktree path is implicit (recorded in state, not in the envelope).

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
│   worktree: .red/tmp/work-wZ2R4-i142/worktree               │
│   stage: impl              heartbeat: :two:                │
│   last: writing tests for callback handler                 │
│                                                            │
│ queue: #143 #144 #145 #146 ...                             │
└────────────────────────────────────────────────────────────┘
```

If stdout is not a TTY (CI, piped log), skip header rendering and print one JSON line per state transition to stderr.

## State File

Path: `.red/tmp/work-{id}-i{N}/afk.state.json` — one snapshot per (worker, issue) iteration. Schema:

```json
{
  "version": 1,
  "worker_id": "wZ2R4",
  "pid": 12340,
  "log": ".red/tmp/work-wZ2R4-i142/afk.log",
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
    "worktree": ".red/tmp/work-wZ2R4-i142/worktree",
    "handoff": ".red/tmp/work-wZ2R4-i142/handoff.md",
    "started_at": "2026-05-16T12:14:00-03:00",
    "stage": "impl",
    "heartbeat_glyph": ":two:",
    "heartbeat_pid": 12345,
    "runner": "codex",
    "retries": 0,
    "last_stream_line": "writing tests for callback handler"
  },
  "durations_seconds": [820, 940, 760],
  "envelope": { "posted": false }
}
```

Atomic write: write to `afk.state.json.tmp` inside the iteration directory, `mv` over the original. `/afk monitor` and any other reader open it read-only. Between issues the worker has no live state file — monitor renders that as "idle".

## Auto-Monitor Loop (Claude Code only — binding)

When `/afk` is invoked **to spawn a worker** (i.e., not the `monitor` subcommand), the agent additionally schedules a recurring `/dev:afk monitor` cron inside the current Claude Code session so the user sees progress without re-typing. Death of every worker auto-cancels the cron.

**Setup (runs immediately after `afk.sh` is launched in the background):**

1. Fetch `CronCreate` and `CronList` via `ToolSearch` if not already loaded (they are deferred tools).
2. `CronList` — if any existing job has `prompt == "/dev:afk monitor"`, **skip step 3** (don't double-schedule when the user runs a second parallel `/afk` in the same session).
3. `CronCreate(cron="*/3 * * * *", prompt="/dev:afk monitor", recurring=true)`. The cron is session-only — it dies when the Claude Code session ends, so no risk of orphans across sessions. Auto-expires after 7 days regardless.
4. Tell the user **one line**: `monitor loop scheduled (every 3 min) — auto-cancels when all workers exit.`

The monitor invocation handles its own teardown — see *Self-Cancel* under the Monitor section below.

**Skip the auto-loop when:**

- The invocation is `/afk monitor` (not a worker spawn).
- The invocation is `/afk --once` (single supervised iteration; user is already watching).
- `CronCreate` is unavailable (not running under Claude Code — e.g. Codex). Print one line `monitor loop unavailable in this runner; tail .red/tmp/work-*/afk.log manually.` and continue.

## Fleet Mode (Claude Code only — binding)

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are user-facing wrappers around [`scripts/supervisor.sh`](scripts/supervisor.sh). They let one terminal command spin up (or shut down) `N` concurrent `afk.sh` workers on the current checkout, with the supervisor handling respawn, the circuit breaker, and per-slot build isolation (see [`scripts/supervisor.sh`](scripts/supervisor.sh) header for the env contract).

Fleet mode is **Claude-Code-only**: the stop side relies on `CronList`/`CronDelete` to tear down the auto-monitor cron from *Auto-Monitor Loop* above, and those primitives don't exist under Codex. When the active runner is Codex (or `CronCreate`/`CronList` is otherwise unavailable), refuse the launch with one line — `fleet mode is not supported under Codex; run /afk in N terminals instead.` — and exit without side effects. Do not touch the PID file, the stop file, or the cron registry.

### `/dev:afk fleet [N]` — launch

`N` is optional and defaults to `2`. Parse it as a non-negative integer; reject anything else (including `stop`, which is the other subcommand and routes below). Steps the agent must perform, in order:

1. **Runner check.** If running under Codex, print the "not supported under Codex" line and exit. Otherwise continue.
2. **PID-file pre-check.** Read `.red/tmp/afk-supervisor.pid`. If it exists and `kill -0 <pid>` succeeds, refuse the launch:
   ```
   ✗ fleet already running (supervisor pid=<pid>, log .red/tmp/afk-supervisor.log).
     to stop it: /dev:afk fleet stop
   ```
   Do **not** touch the file or attempt to recover. A stale PID file (file exists but `kill -0` fails) is left alone — `supervisor.sh` clears it itself on its own `acquire_lock`.
3. **Spawn the supervisor.** From the project root:
   ```bash
   nohup env TARGET=<N> bash plugins/dev/skills/engineering/afk/scripts/supervisor.sh \
     >> .red/tmp/afk-supervisor.log 2>&1 < /dev/null &
   echo $!
   ```
   Capture the printed PID. Wait up to 3 s for `.red/tmp/afk-supervisor.pid` to exist and contain a live PID (read it back — the supervisor writes its own `$$`, which may differ from the shell-level `$!` if a wrapper is involved). If it never appears, treat as a launch failure: tail `.red/tmp/afk-supervisor.log` for the last error and report it; do not retry.
4. **Schedule the auto-monitor cron.** Same flow as *Auto-Monitor Loop* — `CronList` first to deduplicate, then `CronCreate(cron="*/3 * * * *", prompt="/dev:afk monitor", recurring=true)`. Skip if a job with that prompt already exists.
5. **Report back.** Print exactly:
   ```
   🚀 fleet launched (supervisor pid=<pid>, target=<N>)
      log:   .red/tmp/afk-supervisor.log
      stop:  /dev:afk fleet stop
      monitor loop scheduled (every 3 min) — auto-cancels when all workers exit.
   ```
   If the monitor cron was skipped because it already existed, swap the last line for `monitor loop already running (existing cron <id>).`.

### `/dev:afk fleet stop` — graceful shutdown

Steps, in order:

1. **Runner check.** If running under Codex, print `fleet mode is not supported under Codex; nothing to stop.` and exit. (Codex never launched a supervisor here, by definition.)
2. **Liveness check.** Read `.red/tmp/afk-supervisor.pid`. The three cases:
   - File missing → print `no fleet running.` and continue to step 4 (still try to clear any orphaned monitor cron).
   - File present but `kill -0` fails → stale. Print `no fleet running (stale pid file at .red/tmp/afk-supervisor.pid — cleaning).`, `rm -f` it, and continue to step 4.
   - File present and PID alive → continue to step 3.
3. **Touch the stop file.** `touch .red/tmp/afk-supervisor.stop`. The supervisor's health-check cycle (default `SUPERVISOR_POLL_S=15s`) picks it up and runs `cleanup`, which SIGTERMs every worker, removes the PID file, removes the stop file, and exits. Wait up to **30 s** for the PID file to disappear (poll every 1 s, deadline-bounded — never bare `while`). If it's gone, print `🛑 fleet stopped (supervisor pid=<pid> exited).`. If the deadline trips, print one warning line naming the PID and the log path, and continue to step 4 anyway — the stop file is still there and the supervisor will pick it up eventually.
4. **Cancel the auto-monitor cron.** `CronList` → find every job whose `prompt == "/dev:afk monitor"` (there will normally be one, possibly zero, occasionally more if the user manually `/loop`-ed). `CronDelete` each. Print one line: `auto-monitor cron cancelled (<count> entr{y,ies}).` (or `no auto-monitor cron to cancel.` when count is zero). Same teardown logic as *Self-Cancel* in the Monitor section — kept here so the user can force-stop without waiting for the next monitor tick.
5. **Idempotency.** Re-running `/dev:afk fleet stop` after a successful stop just hits the "file missing" branch in step 2 and the "no entries" branch in step 4. Exit 0 either way.

### Refs

- [`scripts/supervisor.sh`](scripts/supervisor.sh) — the binary this section drives. Stop-file path, env contract, and circuit breaker live there.
- *Auto-Monitor Loop* above — the cron lifecycle Fleet Mode hooks into.
- *Self-Cancel* under Monitor — the dual teardown path (cron tears itself down when no workers remain; fleet stop tears it down immediately).

## Monitor

`/afk monitor` is the readonly aggregated view across all live workers. **Implementation is `scripts/monitor.sh` — invoke it directly, do not reinvent the rendering in inline bash.** The script:

1. Globs `.red/tmp/work-*/afk.state.json` and renders one section per active iteration.
2. Verifies liveness via the sibling `afk.pid` — iterations whose PID is dead are flagged `stale` and not counted as running.
3. Optionally tails the sibling `afk.log` for the most recent line under each worker's header.
4. Renders the 48h sparkline header (next subsection) on every refresh.

To invoke, from the project root:

```bash
bash plugins/dev/skills/engineering/afk/scripts/monitor.sh
# or, from an installed plugin cache:
bash ~/.claude/plugins/cache/red-skills/dev/<version>/skills/engineering/afk/scripts/monitor.sh
```

The script has **two modes**, auto-selected by stdout type:

- **TTY (real terminal)**: full box-drawing layout, refreshes every 3 s, `clear` between frames. Ctrl-C to exit.
- **Non-TTY (piped, captured by an agent, redirected)**: one-shot **compact dashboard** — one sparkline header + one line per worker, then exit 0. Force this with `--once` or `MONITOR_COMPACT=1` even from a TTY.

Compact output shape (≈3 lines total for 2 workers — fits inline without truncation in an agent transcript):

```
48h: ···············································█  (4 closed, peak 4/h, all workers)
wZ2R4 [live] claude  4/5 (80%)  #150 [blog/D] Agent SDK on RedDB  stage:impl  00:23:01  +382 -45
wK7M2 [stale] codex  0/16 (0%)  #521 Blockchain Collection Kind   stage:impl  02:00:01
```

When invoking from inside another agent session (Claude Code, Codex), prefer `--once` even if stdin is a pipe — explicit beats inference. Don't use the full TTY mode in agent transcripts; the 3 s refresh loop floods the captured stream and gets truncated to garbage.

Single-worker operation shows one section/line. Multi-worker adds one section/line per live worker, sorted by `started_at`. The sparkline aggregates **all workers** in this checkout's `.red/state/afk-history.jsonl` — not fractured per-worker.

The header of every render shows a **48h sparkline** of issues closed, one glyph per hour, scaled to the peak hour:

```
48h: ·▁··▁·▁·▁··█▁▁··▁·▁···▁·▁·▆▁▁··▁···▁▆·▁··▁▃▁·▃▁·  (35 closed, peak 5/h)
```

Source data: `.red/state/afk-history.jsonl`, an append-only event log written by the orchestrator on every terminal event:

```jsonl
{"ts":"2026-05-17T12:14:00-03:00","epoch":1747494840,"worker":"wK7M2","issue":571,"event":"done","duration_s":816,"runner":"codex","merge_sha":"0936ba54"}
{"ts":"...","epoch":...,"worker":"wK7M2","issue":569,"event":"blocked","duration_s":120,"runner":"codex","reason":"merge-conflict"}
{"ts":"...","epoch":...,"worker":"wK7M2","issue":568,"event":"exhausted","duration_s":0,"runner":"claude","reason":"both-runners"}
```

`.red/state/` is gitignored. The orchestrator creates it during bootstrap, parallel workers serialise appends via `flock`, and `prune_orphans` truncates the file to the last 10000 lines if it grows past that cap.

The sparkline only counts `event == "done"`. Blockers and exhausted runs are recorded for forensics but excluded from the throughput view.

### Self-Cancel (binding when invoked under Claude Code)

Every `/afk monitor` run — whether typed by the user or fired by the auto-monitor cron — is responsible for tearing down the cron once there's nothing left to watch.

After rendering the dashboard, the agent must:

1. Count workers with status `[live]` in the rendered output (i.e., orchestrator pid alive, post-orphan-cleanup).
2. If `live_workers == 0`:
   - Fetch `CronList` and `CronDelete` via `ToolSearch` if not already loaded.
   - `CronList` — find every job with `prompt == "/dev:afk monitor"`. There will normally be exactly one; multiples can appear if the user manually invoked `/loop 3m /dev:afk monitor` on top of the auto-loop.
   - `CronDelete` each match.
   - Append one line to the user-facing output: `🛑 no live workers — auto-cancelled monitor loop (cron <id>).`
3. If `live_workers >= 1`: do nothing. The cron continues firing every 3 minutes.

When `CronList` / `CronDelete` are unavailable (Codex runner, or `/afk monitor` invoked outside Claude Code), skip the teardown silently — the cron infrastructure isn't running there to begin with.

## Handoff File Template

`.red/tmp/work-{id}-i{N}/handoff.md`:

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

## Suggested Skills
{ordered list of skills the inner agent should consider, e.g. `/tdd`, `/diagnose`, `/wiki`. Omit if none beyond the default workflow.}

## Notes
{inner agent appends progress, blockers, decisions here across attempts}
```

The handoff file follows the same minimalism as the `/handoff` skill — reference artifacts by path, do not duplicate their content.

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
