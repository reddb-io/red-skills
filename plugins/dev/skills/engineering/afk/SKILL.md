---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a PRD, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--prd N | --issues N,N,N] [--runner claude|codex] [--alternate] [--fallback-runner] [-n N] [--once] | fleet [N] | fleet stop | monitor"
---

# /afk

Drain the agent-ready backlog. Single skill that owns issue selection, worktree isolation, inner-agent execution, GitHub state coordination, merge-back, and runner-fallback.

## When To Use

- `/afk` — every issue currently labelled `ready-for-agent`.
- `/afk --prd 42` — only issues that reference PRD #42 (by `prd: #42` line in body, parent link, or `prd:42` label).
- `/afk --issues 356,359,362` — explicit list, in that order.
- `/afk --runner codex` — pin a backend (disables detection cascade; mutually exclusive with `--alternate`).
- `/afk --alternate` — opt in to round-robin runner rotation between issues (claude → codex → claude → …).
- `/afk --fallback-runner` — opt in to swapping runners mid-issue when one returns `RUNNER_EXHAUSTED`. Without this flag, exhaustion exits with code 75.
- `/afk -n 5` — cap at five issues (default: drain until empty).
- `/afk --once` — single supervised iteration. Same as `scripts/once.sh`. Use for debugging the prompt.
- `/afk monitor` — readonly status board, aggregates every `.red/tmp/work-*/afk.state.json` so you see all live workers from another terminal.
- `/afk fleet [N]` — launch the supervisor maintaining `N` concurrent workers (default `2`). See *Fleet Mode* below.
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
| `.red/tmp/work-{id}-i{N}/handoff.md` | Handoff file the inner agent reads — `<issue-body>` (issue body verbatim, including the `## Agent brief` markdown section), `<previous-attempts>`, `<human-guidance-thread>` (one `<human-guidance>` per extracted directive), `<thread-discussion>` (advisory comments with no directive marker), `<agent-notes>`. Top-level XML wrappers make body/comments/notes unambiguous. Template in *Handoff File Template* below. |

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
4. Resolve the runner via the detection cascade:
   1. `--runner X` flag (pin) — wins over everything, logged as `detected via --runner pin`.
   2. **Env-var sniff** — `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, or `CLAUDE_CODE_SSE_PORT` → `claude`; `CODEX_HOME`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`, or `CODEX_MANAGED_BY_NPM` → `codex`. Logged as `detected via env-var`.
   3. **Process-tree sniff** — if the invoking process tree contains Claude Code, use `claude`; if it contains Codex, use `codex`. Logged as `detected via process`. This is the normal path for repo-local skill copies whose filesystem path is neutral.
   4. **`$BASH_SOURCE` path sniff** — script lives under `~/.claude/...` → `claude`; under `~/.codex/...` → `codex`. Logged as `detected via path`.
   5. **Env fallback** — `${RED_AFK_RUNNER:-claude}`. Logged as `detected via env-fallback`.
   The boot log prints one line per invocation: `runner: <runner> (detected via <method>)`. Load [`runner-claude.md`](runner-claude.md) or [`runner-codex.md`](runner-codex.md) so the spawn command is ready.
5. Read [`SAFETY.md`](SAFETY.md). It is binding for every shell action the loop takes.
6. Install signal handlers — SIGINT, SIGTERM, and normal exit all release any in-flight issue claim and preserve the active `work-{id}-i{N}/` directory before terminating.

The per-iteration `work-{id}-i{N}/` directory (pid, log, state, handoff, worktree) is created in *Per-Issue Loop* step 1 below, not here — the worker has no files until it claims an issue.

## Orphan Cleanup (boot-time)

Right after bootstrap and before *Straggler Check*, `/afk` sweeps `.red/tmp/work-*/` for orphaned iteration dirs (orchestrator pid dead). For each:

1. **(Slice D — heartbeat sub-shell retired.)** No zombie reap step is needed; older state files may still carry a `heartbeat_pid` but it's vestigial and ignored.
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
2. **Worktree.** Resolve the **pinned branch** (`lib/pin-reader.sh`, ADR 0008): the issue's own `branch:` line, else its parent PRD's, else `main`. Then `git -C primary fetch origin {pinned}` and `git worktree add .red/tmp/work-{id}-i{N}/worktree -b afk/{id}/{N}-{slug} origin/{pinned}` from the primary checkout. The branch is local-only until push. The worktree lives inside the gitignored `.red/tmp/` tree so it never appears in `git status` for `main`.
3. **Handoff file.** Materialise the handoff into `.red/tmp/work-{id}-i{N}/handoff.md` using the template below — top-level XML wrappers (`<issue-body>`, `<previous-attempts>`, `<human-guidance-thread>`, `<agent-notes>`) keep the issue body, orchestrator-authored prior attempts, human comments, and the inner-agent scratchpad unambiguous. `<issue-body>` carries the issue body verbatim (including the `## Agent brief` section written by `/triage`). The handoff file lives one level above the worktree so the inner agent reads it via `../handoff.md` from inside the worktree, and so it survives a worktree wipe on retry.
4. **Local heartbeat marker.** Write one `[heartbeat] iteration started for #N` line to `afk.log`. Slice D retired the periodic GitHub-comment heartbeat (`:one: :two: :three: :four:`) — local liveness is now signalled by the inner-agent stdout stream tee'd into `afk.log` plus state-file mtime, both of which already exist.
5. **Inner agent.** Invoke claude/codex per [`runner-*.md`](runner-claude.md) with [`AGENT-PROMPT.md`](AGENT-PROMPT.md) + the handoff file + last 5 commits of `main`. Stream stdout into the loop's header tail. Detect stages by grep on the stream — see *Stage Detection* below.
6. **Inner result.**
   - Inner committed and emits `<promise>DONE</promise>` → continue to feedback loops.
   - Inner emits `<promise>BLOCKED</promise>` plus notes appended to the handoff file → comment the blocker on the issue, re-label `ready-for-human`, drop the worktree, go to next issue.
   - Inner emits `<promise>NO MORE TASKS</promise>` from inside one iteration → ignored. That sentinel is for the outer loop.
   - Runner-exhausted signal (rate limit / quota error string per runner) → keep the worktree, swap runner, retry the same issue once. If both runners exhaust, exit 75 (`EX_TEMPFAIL`).
7. **Feedback loops.** In the worktree: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`. Any missing script: skip it and note in the validation comment. Any failure: re-enter the inner agent with the failure output appended to the handoff file's Notes. Cap at 2 retries before marking blocked.
8. **Merge.** All steps target the **pinned branch** resolved in step 2 (`{pinned}`, defaults to `main`).
   - Primary dirty? Auto-stage and commit `chore(afk): pre-merge snapshot for #N` in primary. Never `git stash`. Never `git checkout -- .`.
   - `git -C primary fetch origin {pinned}`. The primary checkout is pinned to `main` by the precheck; when `{pinned}` is not `main`, switch the primary checkout onto it for the merge (creating the local branch from `origin/{pinned}` if needed) and **restore it to `main` on every exit path**.
   - **Integrate the fetched tip into local `{pinned}` before merging** (`merge_integrate_origin` in `lib/merge.sh`): fast-forward when local is strictly behind, otherwise rebase local commits onto `origin/{pinned}`. Without this the worker branch merges onto the stale boot-time HEAD and the push is rejected non-fast-forward whenever origin moved mid-run. If integration fails (diverged history that won't rebase), abort the merge → `ready-for-human`.
   - Capture the integrated tip (`pre_merge_sha`), then `git -C primary merge --no-ff afk/{N}-{slug} -m "merge: #{N} {title}"`.
   - Conflict? Try a one-shot self-resolve (`merge_resolve_conflict`): re-enter the inner agent **in primary** with the conflict diff and `git status` as context, instructing it to fix conflicts and `git commit --no-edit` the merge. Resolved = no unmerged paths and no `MERGE_HEAD` left. On still-conflicting: abort with `git merge --abort`, comment the diff on the issue, re-label `ready-for-human`, move on.
9. **Push.** `git -C primary push origin {pinned}` over SSH. Rejected? **Roll the merge commit back** to `pre_merge_sha` (`merge_rollback`) so no orphan merge commit lingers on local `{pinned}`, then comment, re-label `ready-for-human`, move on. Do not retry-loop indefinitely.
10. **Close.** Validation comment on the issue: tests pass/fail, lint, typecheck, build, commits added, files touched. Then `gh issue close N --reason completed`. Remove `running` label.
11. **Cleanup.** `git worktree remove .red/tmp/work-{id}-i{N}/worktree`, `git branch -D afk/{id}/{N}-{slug}` (the branch is already merged into main), then `rm -rf .red/tmp/work-{id}-i{N}/` so the iteration leaves no trace. On blocker paths the directory is preserved for human inspection.
12. **Tick.** Update state file. Recompute ETA from rolling average of last 3 issue durations. Print one summary line: `finished {done}/{total} ({pct}%) — next: #{next}`.

## Runner Fallback

Default behaviour is **no rotation and no fallback** — the runner resolved by the detection cascade (see *Bootstrap* step 4) is used for every issue in the run, and `RUNNER_EXHAUSTED` exits the loop with code 75 and a log line naming the dead runner. Both behaviours are opt-in:

- `--alternate` re-enables round-robin rotation between consecutive issues (claude → codex → claude → …). Mutually exclusive with `--runner`.
- `--fallback-runner` re-enables mid-issue swap when the active runner returns `RUNNER_EXHAUSTED`. Without it, exhaustion is terminal for the run.

Exhaustion detection lives in [`runner-claude.md`](runner-claude.md) and [`runner-codex.md`](runner-codex.md) — they own the per-runner error strings. The orchestrator only sees `RUNNER_EXHAUSTED` as a structured signal.

When swap happens mid-issue (only with `--fallback-runner`), the same worktree and handoff file are reused; the new runner sees the previous agent's Notes appended.

## Sentinel Watchdog

Failure mode observed in production: the inner agent emits `<promise>DONE</promise>` (or `BLOCKED`) but the orchestrator's stream-json pipe stays open for hours. Cause: a tool call the inner agent left running — typically `run_in_background` followed by a `bash -c 'until grep "test result" $out; do sleep 5; done'` polling loop without a timeout. The bg task crashes silently, the loop runs forever, the inner agent can't terminate because the tool call is still active, and the pipeline hangs.

The orchestrator now spawns a watchdog alongside every inner-agent pipeline (`run_sentinel_watchdog`). The watchdog tails the raw stream capture; once it sees `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`, it gives the pipeline `RED_AFK_WATCHDOG_GRACE_S` (default 30) to close cleanly. If the pipeline is still alive at the deadline:

1. `kill_tree pid TERM` — recursively SIGTERM the pipeline pid and every descendant (claude / codex, jq, grep, tee, and any bash child stuck in a polling loop).
2. 5 s grace.
3. `kill_tree pid KILL` — SIGKILL anything still alive.

The orchestrator logs `watchdog: inner emitted sentinel but pipeline still open after Ns — killing tree (likely bash-hang from polling without timeout)` and proceeds with the captured result. The issue is closed normally because the agent's commit work, sentinel, and result are all already on disk by the time the watchdog fires.

Override the grace via `RED_AFK_WATCHDOG_GRACE_S` in the orchestrator's env. Setting it lower than ~5 s risks killing healthy pipelines that just haven't flushed jq's buffer. 30 s is conservative.

Preventive counterpart lives in [`AGENT-PROMPT.md`](AGENT-PROMPT.md) under *Background Tasks and Polling* — inner agents are required to cap every polling loop with a deadline. The watchdog is the safety net; the prompt rule is the design.

## Heartbeat (local-only, post-Slice-D)

The issue-thread heartbeat (`:one:` / `:two:` / `:three:` / `:four:` cycling every 10 minutes via `gh issue comment`) was removed in Slice D. The issue thread is now timeline-only: boot stamp, attempt envelopes, human guidance, closing envelope. No periodic noise.

Local liveness is signalled by:

- **Inner-agent stdout stream**, continuously tee'd into the iteration's `afk.log` by `run_inner` — forensic inspection of a running worker tails this file.
- **State-file mtime**, bumped on every `state_set` call. The monitor combines orchestrator pid liveness with state-file freshness to render `🟢 live` vs `🟡 stale`.
- **Iteration boundary markers** — `heartbeat_start` / `heartbeat_stop` now write a single `[heartbeat]` line each to `afk.log` so forensic readers can see when an iteration entered and left the inner-agent stage.

The terminal header has its own independent 3 s redraw tick — see *Live Header* below. It is unrelated to (and survives the removal of) the GitHub-thread heartbeat.

**Deprecated state fields.** `current.heartbeat_glyph` and `current.heartbeat_pid` are kept as `null` for one release window so older monitors don't error on read; they are no longer written meaningfully and may be removed in a future release.

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

…handoff `<agent-notes>` body…

</details>

</details>
```

Per-status body sections:

- `blocked` → one `data-section="notes"` block carrying the handoff's `<agent-notes>` body (the inner agent's appended progress/blockers).
- `no-sentinel` → both `data-section="notes"` (handoff `<agent-notes>`, may be empty placeholder) **and** `data-section="log"` (last 50 lines of the captured inner-agent stdout, fenced).
- `merge-conflict` → one `data-section="log"` block carrying the merge-conflict diff tail (last 50 lines of `git merge` output), fenced. Mirrors the no-sentinel log shape.
- `done` → no body sections. Summary carries `diff: merged` and `merge: ` `<sha>` (GitHub auto-links bare SHAs to the commit on `main`). The merge commit on `main` *is* the diff — no need to duplicate it inline.

Summary line is always `worker `{id}` · status: {status} · duration: NmSs · diff: {diff} · attempt: K [· merge: {sha}]`, where `{diff}` is `+N -M` against `origin/main` for non-DONE statuses and the literal `merged` for DONE.

After a successful POST (any 2xx), the orchestrator sets `envelope.posted: true` in the iteration state file. The boot-time *Orphan Cleanup* reads that field to pick a TTL for preserved `ready-for-human` dirs: 1 day when the envelope made it to the issue (the thread carries the canonical record), 7 days when the POST failed (the local dir is the only copy of the notes/log). The field is initialised `false` at iteration start.

On any terminal **failure** (BLOCKED, no-sentinel, merge-conflict), the worker branch is pushed via SSH to `origin/afk-attempts/{worker_id}/{issue}-{slug}` before the envelope is posted. The envelope's `data-section="diff"` block then carries a `compare/main...afk-attempts/...` link plus a `+N -M files=K` diffstat. If the push fails (network, auth, anything non-2xx), the iteration still completes — the diff section embeds only the diffstat plus the local worktree path, and a `warn:` line is logged. DONE iterations do **not** push to `afk-attempts/` (the merge commit on `main` is the diff). Local branch cleanup (`git branch -d`) only deletes the local ref; the remote `afk-attempts/` ref stays alive for forensics, with no retention policy in this slice (branch sprawl is acknowledged and deferred — see PRD #2 Out of Scope).

The Slice D heartbeat-glyph cleanup has landed — there is no periodic `:one: :two: …` traffic on the issue thread to defer or replace.

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
│   stage: impl                                              │
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
    "heartbeat_glyph": null,
    "heartbeat_pid": null,
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

## Fleet Mode (runner-portable — binding)

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are user-facing wrappers around [`scripts/supervisor.sh`](scripts/supervisor.sh). They let one terminal command spin up (or shut down) `N` concurrent `afk.sh` workers on the current checkout, with the supervisor handling respawn, the circuit breaker, the **passive stall detector** (samples per-iteration `afk.log` mtimes every `RED_AFK_STALL_POLL_S=30s`; flags any slot alive ≥ `RED_AFK_STALL_THRESHOLD_S=600` whose log has been idle ≥ the same — surfaces as `⏸️ stalled` in `/dev:afk monitor` with no auto-action), and per-slot build isolation (see [`scripts/supervisor.sh`](scripts/supervisor.sh) header for the env contract).

Fleet mode is **runner-portable**: `supervisor.sh` is bash process orchestration, not a Claude Code primitive. Claude Code, Codex, and bare terminals may all launch and stop the supervisor when the normal AFK hard preconditions pass. Runner-specific observability degrades independently:

- Claude Code: schedule the auto-monitor cron when `CronCreate`/`CronList` are available; if not, launch fleet anyway and print `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.`
- Codex: launch fleet with `RED_AFK_RUNNER=codex`, skip cron, and spawn one read-only Codex monitor agent when a sub-agent primitive is available. If no sub-agent primitive is available, launch fleet anyway and print the same manual-monitor guidance.
- Bare terminal / unknown runner: launch fleet, skip cron/native monitor, and print the manual-monitor guidance.

### `/dev:afk fleet [N]` — launch

`N` is optional and defaults to `2`. Parse it as a non-negative integer; reject anything else (including `stop`, which is the other subcommand and routes below). Steps the agent must perform, in order:

1. **Resolve runner.** Determine the active runner using the same intent as the normal AFK cascade: explicit `--runner` if present, else runner env/process/path signals, else `${RED_AFK_RUNNER:-claude}`. The resolved value is carried into the supervisor as `RED_AFK_RUNNER=<runner>` so detached workers do not fall through to the supervisor's historical `claude` fallback. Under Codex, this must be `RED_AFK_RUNNER=codex`.
2. **PID-file pre-check.** Read `.red/tmp/afk-supervisor.pid`. If it exists and `kill -0 <pid>` succeeds, refuse the launch:
   ```
   ✗ fleet already running (supervisor pid=<pid>, log .red/tmp/afk-supervisor.log).
     to stop it: /dev:afk fleet stop
   ```
   Do **not** touch the file or attempt to recover. A stale PID file (file exists but `kill -0` fails) is left alone — `supervisor.sh` clears it itself on its own `acquire_lock`.
3. **Spawn the supervisor.** From the project root:
   ```bash
   nohup env RED_AFK_TARGET=<N> RED_AFK_RUNNER=<runner> bash plugins/dev/skills/engineering/afk/scripts/supervisor.sh \
     >> .red/tmp/afk-supervisor.log 2>&1 < /dev/null &
   echo $!
   ```
   Capture the printed PID. Wait up to 3 s for `.red/tmp/afk-supervisor.pid` to exist and contain a live PID (read it back — the supervisor writes its own `$$`, which may differ from the shell-level `$!` if a wrapper is involved). If it never appears, treat as a launch failure: tail `.red/tmp/afk-supervisor.log` for the last error and report it; do not retry.
4. **Attach the best available monitor surface.**
   - Claude Code: same flow as *Auto-Monitor Loop* — `CronList` first to deduplicate, then `CronCreate(cron="*/3 * * * *", prompt="/dev:afk monitor", recurring=true)`. If cron tools are unavailable, skip and use the manual-monitor line.
   - Codex: fetch a sub-agent spawn primitive via `ToolSearch` (query: `spawn agent background monitor`). If available, spawn exactly one read-only Codex monitor agent for this newly-launched supervisor. Its task: from the project root, periodically run `bash plugins/dev/skills/engineering/afk/scripts/monitor.sh --once`, report concise progress, and auto-close when `.red/tmp/afk-supervisor.pid` is missing/dead and no `[live]` workers remain. It must never edit files, claim issues, stop workers, or run merges. The user may close it manually; workers continue. If the primitive is unavailable, skip and use the manual-monitor line.
   - Bare/unknown: skip native monitor setup and use the manual-monitor line.
5. **Report back.** Print:
   ```
   🚀 fleet launched (supervisor pid=<pid>, target=<N>)
      log:   .red/tmp/afk-supervisor.log
      stop:  /dev:afk fleet stop
      <monitor-status-line>
   ```
   Monitor status line choices:
   - Claude cron scheduled: `monitor loop scheduled (every 3 min) — auto-cancels when all workers exit.`
   - Claude cron already existed: `monitor loop already running (existing cron <id>).`
   - Codex monitor agent spawned: `Codex monitor agent spawned — auto-closes when fleet exits; manual monitor: /dev:afk monitor.`
   - Native monitor unavailable: `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.`

### `/dev:afk fleet stop` — graceful shutdown

Steps, in order:

1. **Liveness check.** Read `.red/tmp/afk-supervisor.pid`. The three cases:
   - File missing → print `no fleet running.` and continue to step 3 (still try runner-specific monitor teardown).
   - File present but `kill -0` fails → stale. Print `no fleet running (stale pid file at .red/tmp/afk-supervisor.pid — cleaning).`, `rm -f` it, and continue to step 3.
   - File present and PID alive → continue to step 2.
2. **Touch the stop file.** `touch .red/tmp/afk-supervisor.stop`. The supervisor's health-check cycle (default `RED_AFK_POLL_S=15s`) picks it up and runs `cleanup`, which SIGTERMs every worker, removes the PID file, removes the stop file, and exits. Wait up to **30 s** for the PID file to disappear (poll every 1 s, deadline-bounded — never bare `while`). If it's gone, print `🛑 fleet stopped (supervisor pid=<pid> exited).`. If the deadline trips, print one warning line naming the PID and the log path, and continue to step 3 anyway — the stop file is still there and the supervisor will pick it up eventually.
3. **Tear down runner-specific monitors.**
   - Claude Code: `CronList` → find every job whose `prompt == "/dev:afk monitor"` (there will normally be one, possibly zero, occasionally more if the user manually `/loop`-ed). `CronDelete` each. Print one line: `auto-monitor cron cancelled (<count> entr{y,ies}).` (or `no auto-monitor cron to cancel.` when count is zero). If cron tools are unavailable, print `auto-monitor cron unavailable in this runner; skipped.`
   - Codex: do not stop workers through the monitor agent. It auto-closes when it observes no supervisor/live workers, and the user may close it manually. Print `Codex monitor agent will self-close when it observes fleet stopped.`
   - Bare/unknown: print `no native monitor teardown for this runner.`
4. **Idempotency.** Re-running `/dev:afk fleet stop` after a successful stop just hits the "file missing" branch in step 1 and the runner-specific teardown no-op in step 3. Exit 0 either way.

### Circuit Trip Sweep

When the circuit breaker parks a slot (`CIRCUIT_K` fast deaths inside `CIRCUIT_WINDOW_S`) the supervisor — not a human — runs `sweep_parked_slot` to clean up after the burned workers. Three actions, in order, gated on the trip:

1. **Sweep affected iter dirs.** From the slot log (`afk-supervisor-slot-{slot}.log`) the supervisor parses every `[afk] worker: w…` boot stamp emitted while the slot was alive, globs `.red/tmp/work-{wid}-i*/` for each ID, and reads `afk.state.json`'s `.current.number` to identify the affected issues. Each iter dir is `rm -rf`'d after its issue has been processed.
2. **Post a discard envelope on each affected issue.** Same `<details data-attempt-status="…">` schema as `build_envelope` in `afk.sh`, with `status="discarded"` and a summary line that names the runner and the trip cause (`runner-broken, slot parked after K fast deaths`). The envelope's `data-section="summary"` block carries the slot index, comma-joined worker IDs, fast-death count, and the supervisor log path. No `notes`, `drop`, or `log` sections — the attempts produced no usable artefacts.
3. **Restore label state on each affected issue.** Single `gh issue edit` adds `ready-for-agent` and `runner-error`, removes `ready-for-human` and (defensively) `running` — covers both the "issue had already been promoted to `ready-for-human`" path and the "issue was still `running` at the moment of trip" path.

The `runner-error` label is created idempotently by `/setup-red-skills` (see [triage-labels.md](../setup-red-skills/triage-labels.md)). The supervisor still calls `gh label create runner-error` on the fly during a trip so cleanup never fails just because the label is missing.

Idempotency: `SLOT_SWEPT[slot]=1` blocks a second sweep within the same supervisor lifetime. Across restarts a new trip yields fresh worker IDs and fresh iter dirs, so re-tripping never re-touches the previously swept issues. A trip that finds no claimed issues (all workers exited before claiming) parks the slot but posts no envelopes — the iter-dir sweep is a no-op.

### Refs

- [`scripts/supervisor.sh`](scripts/supervisor.sh) — the binary this section drives. Stop-file path, env contract, circuit breaker, and trip-sweep live there.
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
- **Non-TTY (piped, captured by an agent, redirected)**: one-shot **compact dashboard** — one sparkline header + one line per worker, then exit 0. Force this with `--once` or `RED_AFK_MONITOR_COMPACT=1` even from a TTY.

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

### Task Mirror And Codex Monitor Agent (binding)

Every `/dev:afk monitor` run also **mirrors each live worker onto the runner's native task list when that runner exposes one**, so a `/afk` session surfaces progress on the host's native UI — advancing through stages on its own, with no extra typing. This is a **read-only reflection of `afk.state.json`**; the mirror never writes state and never touches `afk.sh` orchestration.

The pure diff logic lives in [`scripts/lib/mirror.sh`](scripts/lib/mirror.sh). After rendering the dashboard, the agent (under Claude Code only) must:

1. Fetch `TaskCreate`, `TaskUpdate`, and `TaskList` via `ToolSearch` if not already loaded (deferred tools).
2. **Build the tracked set.** `TaskList` → keep the mirror-owned tasks (those whose title matches `#<n> w<id> — …`). For each, emit one JSONL line `{"key":"<worker_id>:<issue>","stage":"<last stage>"}`, reading the key from the title and the stage from the description (`stage: <x>`). Keep a key→task_id map for step 4.
3. **Compute the plan.** From the project root:
   ```bash
   bash plugins/dev/skills/engineering/afk/scripts/lib/mirror.sh  # sourced, not run
   ```
   Call `mirror_plan "$PWD" "$tracked_jsonl"`, where `$tracked_jsonl` is the newline-joined output of step 2. It globs the state files, reconciles against the tracked set (keyed by `worker_id:issue`, so parallel workers each get exactly one task and re-runs never duplicate), and prints a JSONL **call plan** — one descriptor per harness call:
   ```jsonl
   {"call":"TaskCreate","key":"wAAAA:22","title":"#22 wAAAA — extract state.sh","description":"stage: impl","state":"in_progress"}
   {"call":"TaskUpdate","key":"wAAAA:22","description":"stage: tests","state":"in_progress"}
   {"call":"TaskUpdate","key":"wAAAA:22","state":"completed"}
   ```
4. **Apply the plan.** For each descriptor in order:
   - `TaskCreate` → create the task; record `key → task_id`.
   - `TaskUpdate` → resolve `key` to its `task_id` via the map and update. A `state` of `completed`/`failed` marks the worker's terminal event (`done`/`blocked`); the task drops off the active list and the mirror self-cleans. A descriptor whose `key` has no known `task_id` (e.g. a complete for a task that was never created in this session) is skipped.

An empty plan means nothing changed since the last tick — apply no calls. Because the plan is keyed by `worker_id:issue`, an idempotent re-run with no stage advance emits zero descriptors.

**Re-hydration on session reopen.** A native task dies with the Claude Code session; the `nohup` AFK worker does not. When a session opens with workers still running, `TaskList` (step 2) returns no mirror-owned tasks, so the tracked set is **empty** and `mirror_plan` reconciles cold — emitting a `TaskCreate` for every live worker. The status bar recovers the per-worker tasks with no operator action. This is the same path as steady-state, not a new one: only workers whose `afk.pid` is alive re-hydrate (dead workers are untracked-terminal on a cold tick → no ghost task), and the next tick is idempotent because the freshly-created tasks now form the tracked set.

When `TaskCreate` / `TaskUpdate` are unavailable because the session is **outside any runner** (a bare terminal), **skip the mirror silently** — there is no native surface to drive, and `monitor.sh` is already the canonical view.

**Codex sink (runner-specific — binding).** The mirror is per-runner, mirroring the `runner-claude.md` / `runner-codex.md` split (ADR 0003). Under Codex the `state-reader` and `mirror-reconciler` are reused unchanged — only the sink differs. After rendering the dashboard, the Codex agent calls [`mirror_sink_codex "$PWD" "$tracked_jsonl"`](scripts/lib/mirror.sh) instead of the Claude `TaskCreate`/`TaskUpdate` loop:

- If Codex grows a native background-task surface, override `codex_native_task_available` to return 0 and the sink emits the **same `mirror_plan` call descriptors** the Claude sink applies — apply them against the Codex primitive.
- Otherwise (today's reality), the sink falls back to the `monitor.sh` dashboard and emits a one-line notice. No native calls are emitted, so there is no half-rendered state, and a `monitor.sh` hiccup is swallowed so the tick never crashes.

**Codex monitor agent (fleet-specific — binding).** Codex has a native sub-agent UI even though it does not expose the Claude-style `TaskCreate`/`TaskUpdate` task API. When `/dev:afk fleet N` launches a new supervisor under Codex, the agent should spawn exactly one read-only Codex monitor agent when the sub-agent primitive is available. That monitor agent periodically runs `monitor.sh --once`, reports concise progress, and exits once no supervisor or live workers remain. It is a presentation consumer only: it must not edit files, stop workers, claim issues, or merge anything. Closing it manually must not affect the fleet.

Do **not** invent a cross-runner task abstraction (rejected in ADR 0003) — keep the adapter explicitly per-runner.

## Handoff File Template

`.red/tmp/work-{id}-i{N}/handoff.md`:

Top-level content is XML elements (not markdown headers) so the inner agent
cannot confuse the issue body with comments, or human direction with
orchestrator audits. Markdown sections like `## Agent brief`, `## Acceptance`,
`## Refs`, and `## Suggested Skills` live *inside* the `<issue-body>` element
(they are part of the issue body verbatim).

```markdown
# Issue #{N} — {title} [AFK]

source: {gh-url}
prd: {prd-url-or-issue-ref}        # omit if none
runner: {claude|codex}
started: {iso8601}
attempt: {1..}

<issue-body>
{issue body verbatim — includes the `## Agent brief`, `## Acceptance`, `## Refs`,
and `## Suggested Skills` markdown sections written by /triage}
</issue-body>

<previous-attempts>                                    <!-- omitted when empty -->
<previous-attempt n="1" status="blocked" worker="wXXXX" duration="0m50s" branch="afk-attempts/wXXXX/N-slug">
<notes>
{inner agent's appended notes from prior attempt}
</notes>
<log>
{tail of prior attempt's stdout, if captured}
</log>
</previous-attempt>
</previous-attempts>

<human-guidance-thread>                                <!-- omitted when empty -->
<human-guidance author="@alice" at="{iso8601}">
{verbatim content of one extracted <details data-kind="directive"> marker — one
<human-guidance> element per directive, so a single comment carrying two markers
emits two siblings with identical author/at}
</human-guidance>
</human-guidance-thread>

<thread-discussion>                                    <!-- omitted when empty -->
<thread-discussion-entry author="@alice" at="{iso8601}">
{human comment body verbatim that carried no directive marker — advisory only,
lowest authority; orchestrator audits already filtered out by body shape}
</thread-discussion-entry>
</thread-discussion>

<agent-notes>
<!-- inner agent appends progress/blockers here across attempts -->
</agent-notes>
```

The handoff file follows the same minimalism as the `/handoff` skill — reference artifacts by path, do not duplicate their content.

## Stop Conditions

- Queue drained → `<promise>NO MORE TASKS</promise>` → exit 0.
- `-n N` reached → summary + exit 0.
- Both runners exhausted → exit 75.
- Uncaught error in orchestrator → leave worktree in place, exit 1, print recovery hint. (No heartbeat sub-shell to kill since Slice D.)

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
