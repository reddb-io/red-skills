---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a PRD, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--prd N | --issues N,N,N] [--runner claude|codex|opencode] [--alternate] [--fallback-runner] [--request TEXT] [-n N] [--once] [--boot-only] | fleet [N] | fleet stop | monitor | dashboard | daily-review | weekly-review | retake N | reap"
---

# /afk

Drain the agent-ready backlog. Single skill that owns issue selection, worktree isolation, inner-agent execution, GitHub state coordination, merge-back, and runner-fallback.

> **Run this skill — do not read its code.** This `SKILL.md` is the complete behavioural contract. The `bin/` bundle and the `scripts/` shell files are **build/runtime artifacts**, not documentation: opening them to "understand what `/afk` does" wastes context and is never required. Everything an agent needs to operate `/afk` is in this file.

<what-to-do>

## Invocation

Invoke the committed runtime bundle with the command you want to run:

```
RED_AFK_RUNNER=<claude|codex> node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" <command> [params]
```

The environment variable `RED_AFK_RUNNER` must match the host runner (`claude` from Claude Code, `codex` from Codex).

Commands are `run` (the default when no subcommand is given, or a bare token with preserved argv), `monitor`, `dashboard`, `daily-review`, `weekly-review`, `retake`, `fleet`, `reap`, and the hidden `__supervise` (fleet supervisor only — never invoke by hand).

## When To Use

- `/afk` — drain every issue labelled `ready-for-agent`.
- `/afk --prd 42` — only issues that reference PRD #42.
- `/afk --issues 356,359,362` — explicit list, in that order.
- `/afk --runner codex` — pin a backend (disables detection cascade).
- `/afk --alternate` — round-robin runner rotation between issues.
- `/afk --fallback-runner` — swap runners mid-issue on `RUNNER_EXHAUSTED`.
- `/afk --request "..."` or `/afk -r "..."` — add a special user request block to every inner-agent prompt.
- `/afk -n 5` — cap at five issues (`-n 0` or omitting `-n` drains the whole queue).
- `/afk --once` — single supervised iteration (debug mode).
- `/afk --boot-only` — run bootstrap then exit; dry-run to inspect cleanup.
- `/afk monitor` — readonly aggregated view of all live workers.
- `/afk dashboard [--period 30d] [--json]` — readonly process dashboard.
- `/afk daily-review [--json]` — readonly daily operational review.
- `/afk weekly-review [--json]` — readonly six-day operational review.
- `/afk retake 123 [--apply] [--json]` — issue resumption report.
- `/afk fleet [N]` — launch supervisor maintaining `N` concurrent workers (default `2`).
- `/afk fleet stop` — gracefully shut down a running fleet.
- `/afk reap` — run branch hygiene without starting a worker.

## Parallelization

Run `/afk` from multiple terminals — no flags, no coordination. Each spawns its own worker:

```bash
/afk            # terminal A → spawns worker "wZ2R4"
/afk            # terminal B → spawns worker "wK7M2"
/afk            # terminal C → spawns worker "w9RQP"
```

Each gets a unique **worker ID** (literal `w` + 4 random characters) used as the prefix for per-run files. Print the ID on the first line so you can tail or kill it later.

## Hard Preconditions

The skill refuses to start if any of these fail:

- `git remote -v` shows only SSH remotes. Reject HTTPS — never auto-rewrite.
- `gh auth status` succeeds.
- Repo has a `main` branch and `git -C primary log -1 main` works.
- Issue tracker label `ready-for-agent` exists. If not, point at `/triage`.
- `pnpm` is on PATH (logger and tooling guidelines assume pnpm).

## How AFK Works — The Core Loop

For each issue:

1. **Claim** the issue via `gh issue edit` (remove `ready-for-agent`, add `running`).
2. **Create a worktree** branching off the base (main by default).
3. **Handoff file** — materialize the issue body, prior attempts, and human guidance.
4. **Inner agent** — invoke the sandcastle Orchestrator with the handoff. The agent works in the worktree and emits `<promise>DONE</promise>` or `<promise>BLOCKED</promise>` when finished.
5. **Feedback loops** — run `test`, `typecheck`, `lint`, `build` with `pnpm` on touched scopes.
6. **Merge** — integrate and land the worktree onto the base branch (or into a PR if unlocked).
7. **Close** — post a validation comment, `gh issue close`, delete the live remote branch.
8. **Cleanup** — drop the worktree, retain attempt logs for post-mortem, run the completion sweep.

The per-issue attempt directory lives under `.red/tmp/workers/{id}/{N}-a{n}/`. On terminal failure the directory is preserved; on DONE it is reclaimed immediately. Every issue lives in its own attempt directory across all workers — two workers cannot claim the same issue.

## Execution Substrate (ADR 0033)

AFK drives the per-issue **agent run** via [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle) — the execution substrate is separate from AFK's policy. sandcastle spawns the inner agent, manages the git worktree, runs the configured sandbox, captures the agent's stream, and detects the completion signal; AFK keeps everything around that: issue selection, the claim, the handoff, the feedback gate, landing, envelope, and close. See `AGENT-PROMPT.md` for the inner agent's contract — the agent authors its own exit via `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`.

## State & Monitoring

Live workers write state snapshots to `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json` (schema in *State File* under *Supporting Info* below). Run `/afk monitor` from another terminal to see progress across all workers on this machine. The monitor also mirrors each live worker onto the Claude Code task surface (or the Codex monitor agent), so progress advances in your native UI without extra typing.

## Stop Conditions

- Queue drained → exit 0.
- `-n N` reached → exit 0.
- Runner exhaustion (without `--fallback-runner`) → route through bounded recovery, exit 75.
- Uncaught error in orchestrator → exit 1, print recovery hint.

</what-to-do>

<supporting-info>

## Reference Material

Detailed guidance on specific topics — consult on demand:

- **`AGENT-PROMPT.md`** — the inner agent's contract, termination bounds, polling rules.
- **`SAFETY.md`** — binding shell-action rules for the orchestrator and inner agent.
- **`runner-{claude,codex,opencode}.md`** — per-runner spawn commands, runner-specific error strings, exhaustion detection.
- **REFACTORED DOCS** (listed below) — schema, lifecycle, configuration, hooks, troubleshooting.

### Per-Worker & Per-Attempt File Layout

| Path | Purpose |
|---|---|
| `.red/tmp/workers/{id}/worker.pid` | Per-worker liveness anchor: the orchestrator's PID, written once at bootstrap. |
| `.red/tmp/workers/{id}/{N}-a{n}/worktree/` | Git worktree for issue `N` on attempt `n`. |
| `.red/tmp/workers/{id}/{N}-a{n}/afk.log` | Append-only plain log for this attempt. |
| `.red/tmp/workers/{id}/{N}-a{n}/agent.log.jsonl` | Clean agent lane — one `type=agent` JSONL record per assistant turn. |
| `.red/tmp/workers/{id}/{N}-a{n}/log.jsonl` | Firehose — every record of the attempt in the uniform JSONL envelope. |
| `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json` | State snapshot for this attempt. |
| `.red/tmp/workers/{id}/{N}-a{n}/handoff.md` | Handoff file the inner agent reads. |
| `.red/tmp/workers/{id}/{N}-a{n}/validation.jsonl` | Structured JSONL sidecar from feedback validation. |

### Attempt Outcomes & Recovery Caps

AFK labels terminal failures with a typed `blocked:<reason>` label. Recoverable reasons retry; at/over the cap they escalate to `ready-for-human`:

| Outcome | typed label | recovery | default cap |
|---|---|---|---|
| `done` | none | none | n/a |
| `blocked` | `blocked:spec` | none — escalates immediately | n/a |
| `no-sentinel` | `blocked:crashed` | `crashed` | `RED_AFK_RETRY_CRASH=1` |
| `merge-conflict` | `blocked:merge-conflict` | `merge-conflict` | `RED_AFK_RETRY_MERGE=3` |
| `exhausted` | `blocked:quota` | `quota` | `RED_AFK_RETRY_QUOTA=3` |
| `runner-transient` | `blocked:runner-transient` | `runner-transient` | `RED_AFK_RETRY_RUNNER_TRANSIENT=3` |
| `feedback-failed` | `blocked:validation` | none — escalates immediately | n/a |
| `hook-aborted` | `blocked:policy` | none — escalates immediately | n/a |
| `stalled` | `blocked:stalled` | none — escalates immediately | n/a |
| `infra` | `blocked:infra` | none — escalates immediately | n/a |

### Environment Variables & Configuration

Key overridable env vars (see `.red/config.yaml` under `afk:` for defaults):

- `RED_AFK_RUNNER` — caller runner identity (`claude` / `codex` / `opencode`).
- `RED_AFK_IDLE_TIMEOUT_S` — per-iteration silence watchdog (default `600` s).
- `RED_AFK_MAX_ITERATIONS` — sandcastle re-invocation ceiling (default `12`).
- `RED_AFK_ATTEMPT_TIMEOUT_S` — commit-anchored progress guard (default `2700` s).
- `RED_AFK_RETRY_QUOTA`, `RED_AFK_RETRY_CRASH`, `RED_AFK_RETRY_MERGE`, `RED_AFK_RETRY_RUNNER_TRANSIENT`, `RED_AFK_RETRY_POLICY` — recovery caps.
- `RED_AFK_STALL_THRESHOLD_S`, `RED_AFK_STALL_KILL_THRESHOLD_S`, `RED_AFK_STALL_POLL_S` — fleet stall detection.
- `RED_AFK_ATTEMPT_TTL_S`, `RED_AFK_ATTEMPT_KEEP` — boot-time attempt dir retention.
- `RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S` — remote snapshot-branch retention after completion.
- `RED_AFK_HEARTBEAT_S` — periodic orchestrator heartbeat interval (default `60` s).

### Bootstrap & Cleanup

Before the first iteration, AFK:

1. Ensures `.red/tmp/` exists and is in `.gitignore`.
2. Generates a unique worker ID (`w` + 4 random chars).
3. Resolves the runner via detection cascade (flag > env > sniff > fallback).
4. Writes `worker.pid` (the orchestrator PID) as the liveness anchor.
5. Reads `SAFETY.md` rules and installs signal handlers.

Right after bootstrap, AFK:

1. **Orphan cleanup** — drains leftover `.red/tmp/work-*/` dirs and sweeps nested attempt dirs whose worker `worker.pid` is dead.
2. **Attempt cap** — per-issue prunes anything over the age or count cap (default 14 days / 5 attempts).
3. **Snapshot branch grace cleanup** — reaps remote `afk-attempts/*` for closed issues past the grace window (default 7 days).
4. **Unblock sweep** — promotes `blocked:dependency` issues to `ready-for-agent` when all their deps closed.
5. **Straggler check** — warns if unlabeled/needs-triage/needs-info issues exist.

### Issue Lifecycle State Machine

```
ready-for-agent
       │
   (claim)
       ▼
    running
   ┌───┴───┐
   │ inner agent: DONE | BLOCKED
   │
   ├── DONE + merged
   │       │
   │   (close)
   │       ▼
   │    closed
   │
   └── terminal failure
           │
       (classify)
       ├─ recoverable & under cap → add ready-for-agent
       └─ non-recoverable or at cap → add ready-for-human
```

Dependencies use `req:N` edge labels and `blocked:dependency` state. A dependent issue is promoted to `ready-for-agent` when all its `req:*` issues are closed (close cascade, then boot-time unblock sweep). Use `## Blocked by` for mechanical dependencies; use `## Current blocker` for gates/decisions/products that `ready-for-human` gates.

### Terminal-Event Envelope

Every terminal event posts **exactly one** structured comment on the issue. Envelopes are the canonical record of what the worker saw and did.

| status | trigger |
|---|---|
| `blocked` | spec block, validation failure, or generic failure |
| `no-sentinel` | inner agent exited without `<promise>` |
| `merge-conflict` | orchestrator could not merge to `{pinned}` |
| `done` | success — merged, closing |
| `discarded` | supervisor circuit-breaker discard |

Schema:

```html
<details data-attempt-status="blocked">
<summary>worker `wZ2R4` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1</summary>

<details data-section="notes"><summary>notes</summary>
{handoff `<agent-notes>` body}
</details>

</details>
```

Every non-`discarded` terminal envelope also carries a trailing `data-section="hooks"` block when at least one **user-declared** lifecycle hook ran (not built-ins), listing each hook's name, command, and exit code.

On terminal failure, the live iteration branch (`afk/{id}/{N}-{slug}`) survives on origin for inspection; a failure-only marker (`afk-attempts/{id}/{N}-{slug}`) is also pushed for forensics. On DONE the live branch is deleted after close.

### Dependency Unblock — `req:N` edges

Dependencies are **`req:N` edge labels** (one per blocker), and a blocked issue holds **`blocked:dependency`** state (not `ready-for-human` — it is healthy, waiting, never pages).

Two mechanisms promote it to `ready-for-agent`:

1. **Close cascade** — immediately after closing issue #N, re-evaluate every dependent and promote it if all its `req:*` issues are now closed.
2. **Unblock sweep** — boot-time safety net that re-scans `blocked:dependency` issues and promotes any whose deps all closed.

### Current Blocker State

Human gates are first-class issue-body state. Before claiming an issue, AFK checks for an active `## Current blocker` block:

```md
## Current blocker

<!-- red:blocker-state v1 -->
status: blocked
kind: decision
ref: #856
summary: Phase 2 measured no columnar read win.
next: Human must decide whether to stop, redesign, or continue anyway.
<!-- /red:blocker-state -->
```

If this block is present with `status: blocked`, AFK removes `ready-for-agent`, adds `ready-for-human` plus the typed blocker label, and waits for `/hitl`.

When an attempt escalates to a terminal human page, the runtime writes or replaces this block so `/hitl` can start from the current blocker instead of re-reading old envelopes. `/hitl` clears the block and moves the issue back to `ready-for-agent` when the next agent can continue.

### Runner Fallback

Default behaviour is **no rotation and no fallback** — the resolved runner is used for every issue. `RUNNER_EXHAUSTED` routes through bounded recovery as `blocked:quota`, with a cap (default 3 retries), then escalates to `ready-for-human` at/over the cap.

- `--alternate` enables round-robin rotation (claude → codex → claude → …). Mutually exclusive with `--runner`.
- `--fallback-runner` enables mid-issue swap when the active runner returns `RUNNER_EXHAUSTED`. Without it, exhaustion is terminal and routes through bounded recovery.

### Attempt Completion & Termination Bounds

The `<promise>DONE</promise>` or `<promise>BLOCKED</promise>` sentinel the inner agent emits is the **canonical "attempt is over" signal**. sandcastle stops re-invoking the agent the moment one is observed. Three independent bounds cap a run that never signals:

- **`idleTimeoutSeconds`** (default **600 s**, env `RED_AFK_IDLE_TIMEOUT_S`) — per-iteration silence watchdog: an iteration producing no output for this long is aborted.
- **`maxIterations`** (default **12**, env `RED_AFK_MAX_ITERATIONS`) — sandcastle re-invocation ceiling: a run that never signals but keeps re-exploring can re-invoke up to this many times.
- **Commit-anchored attempt guard** (default **2700 s**, env `RED_AFK_ATTEMPT_TIMEOUT_S`, ADR 0044/0045) — proof-of-progress: a busy run that lands no NEW commit within the cap is aborted. Armed only under `none` (no-sandbox) isolation. Maps to `timeout` outcome → `blocked:stalled` / `ready-for-human`.

See `AGENT-PROMPT.md` *Background Tasks and Polling* — inner agents must cap every polling loop with a deadline.

### Heartbeat & Liveness

The issue-thread heartbeat (`:one:` / `:two:` cycling) was removed. Local liveness is signalled by:

- **Inner-agent stream** — captured and surfaced via `afk.log` + the JSONL lanes.
- **Clean agent lane** (`agent.log.jsonl`) — one `type=agent` record per turn, never synthetic; the true liveness signal.
- **State-file mtime** — bumped on every state update.
- **Periodic orchestrator heartbeat** — every `RED_AFK_HEARTBEAT_S` (default 60s), appends `[heartbeat] stage:tests t+00:14:02 cpu=12% rss=420M` to `afk.log`.

When tailing a worker, read `agent.log.jsonl` for real liveness; `afk.log` carries the periodic heartbeat so a silent agent still produces one line per minute.

### Solo-Run Stall Protection

A solo `/afk run` is protected by two in-process layers (armed only under no-sandbox isolation):

- **Attempt progress guard** — aborts when no NEW commit lands within `RED_AFK_ATTEMPT_TIMEOUT_S` (default 2700s), resetting on every commit. Maps to `blocked:stalled`.
- **Lane-idle reaper** — samples the agent lane mtime every `RED_AFK_STALL_POLL_S` (default 30s). A worker alive ≥ `RED_AFK_STALL_THRESHOLD_S` (default 600s) whose agent lane is idle ≥ the same is a candidate; past `RED_AFK_STALL_KILL_THRESHOLD_S` (default 1800s) and with no active descendant (`vitest`/`tsc`/`cargo`/build) or flat CPU, it is reaped tree-wide. Maps to `no-sentinel`.

### Fleet Mode

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are the user-facing commands:

**Launch:**
1. Resolve runner (explicit `--runner` > `RED_AFK_RUNNER` > sniff > `claude`).
2. Pre-check `.red/tmp/afk-supervisor.pid` — refuse if a live supervisor already runs.
3. Launch the supervisor and wait for the PID file to appear.
4. Attach the best available monitor (Claude cron, Codex agent, or manual).
5. Print the supervisor PID and monitor status.

**Stop:**
1. Liveness check on `.red/tmp/afk-supervisor.pid`.
2. Touch `.red/tmp/afk-supervisor.stop` if alive.
3. Wait up to 30 s for the PID file to disappear.
4. Tear down runner-specific monitors (Claude cron, Codex agent).

The supervisor handles respawn, circuit breaker (fast deaths inside a window park the slot), passive stall detector (samples agent lane mtime), hard stall reaper (irreversible kill for genuinely stuck workers, gated behind a busy predicate), and per-slot build isolation.

**Circuit trip** — when `CIRCUIT_K` fast deaths occur inside `CIRCUIT_WINDOW_S`, the supervisor sweeps affected attempt dirs, posts `discarded` envelopes on affected issues, and restores label state (`ready-for-agent` + `runner-error`).

### Monitor

`/afk monitor` is the readonly aggregated view across all live workers. It globs `.red/tmp/workers/*/*/afk.state.json`, verifies liveness via the orchestrator PID, and renders one section per active attempt.

Two modes:
- **TTY** — full box-drawing layout, refreshes every 3 s, Ctrl-C to exit.
- **Non-TTY** — one-shot compact dashboard (one sparkline + one line per worker), exit 0. Force with `--once` or `RED_AFK_MONITOR_COMPACT=1`.

The monitor also **mirrors each live worker onto the native task surface** (Claude Code tasks, or Codex monitor agent). This is **binding** — run the mirror every tick, even if just answering "how are we?". The mirror is idempotent and emits zero descriptors when nothing changed.

**Self-cancel** — after rendering the dashboard, if `live_workers == 0`, `CronDelete` every auto-monitor cron and exit.

**Task mirror** — pipe the tracked-task JSONL into `monitor --mirror-plan`, apply the emitted call plan via `TaskCreate`/`TaskUpdate`. The mirror is keyed by `worker_id:issue` so parallel workers each get exactly one task. On session reopen with workers still running, the tracked set is empty and `monitor --mirror-plan` reconciles cold, emitting `TaskCreate` for every live worker.

**Codex sink** — under Codex, `monitor --mirror-plan --runner codex` emits the same descriptors; if Codex grows a native task surface, use it; otherwise fall back to the dashboard + notice.

### Configuration & Hooks

Scalar settings live in `.red/config.yaml` under `afk:` with matching `RED_AFK_*` env overrides (env wins). Lifecycle hooks are ordered lists of shell commands under `afk.hooks` with fixed lifecycle points and a single interceptor contract (input: JSON context on stdin; output: empty or mutated JSON; exit code: 0 continues, non-zero routes per hook policy). Built-in defaults run first, user hooks after, in declaration order. Disable a built-in with `afk.hooks.defaults.<name>: false`.

Shipped built-ins: `cargo`, `gradle`, `heartbeat`, `envelope`, `validation`. See `CHANGES.md` for full configuration schema and examples.

### Backpressure Gate

`afk.backpressure` is an ordered list of shell commands that supplements (not replaces) the auto-derived feedback gate. On DONE, after the scope-derived `test`/`typecheck`/`lint`/`build` feedback passes, each command runs in order. If any exits non-zero the merge is blocked (`blocked:validation`), the command and output tail land in the terminal envelope and validation sidecar, and the issue is parked to `ready-for-human`.

### Merge-Gate Policy

The unlocked admin-merge (`gh pr merge --admin --merge`) **ignores advisory review checks by default** — this is intentional. The binding gates are:

1. **`drift-guard`** — the `pre_merge` hook, a hard gate.
2. **In-process backpressure / feedback** — the pre-merge feedback-validation step.

External advisories (CodeRabbit, etc.) are not binding. Opt into waiting with `afk.merge.wait_for_review: true` — the landing then polls the configured review check until it concludes and merges regardless (so reviews post before the merge but never block the land).

### On-Demand Branch Reaper

Run `/afk reap` to perform branch hygiene without claiming an issue. The command prints `afk branch counts: remote-afk=N remote-afk-attempts=N local-afk=N` then applies the same three namespace reapers used at boot. Open issues and transiently unclassified issues are kept; local branches checked out by any worktree are kept.

### State File Schema

Path: `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json`

```json
{
  "version": 1,
  "worker_id": "wZ2R4",
  "pid": 12340,
  "log": ".red/tmp/workers/wZ2R4/142-a1/afk.log",
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
    "worktree": ".red/tmp/workers/wZ2R4/142-a1/worktree",
    "handoff": ".red/tmp/workers/wZ2R4/142-a1/handoff.md",
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

State is updated atomically: write to `afk.state.json.tmp`, then `mv` over the original.

### Handoff File Template

`.red/tmp/workers/{id}/{N}-a{n}/handoff.md` — top-level content is XML elements so the inner agent cannot confuse the issue body with comments or orchestrator audits:

```markdown
# Issue #{N} — {title} [AFK]

source: {gh-url}
runner: {claude|codex}
started: {iso8601}
attempt: {1..}

<issue-body>
{issue body verbatim — includes markdown sections like `## Agent brief`, `## Acceptance`, `## Refs`}
</issue-body>

<previous-attempts>
<previous-attempt n="1" status="blocked" worker="wXXXX" duration="0m50s" branch="afk-attempts/wXXXX/N-slug">
<notes>{inner agent's notes from prior attempt}</notes>
<log>{tail of prior stdout if captured}</log>
</previous-attempt>
</previous-attempts>

<prior-attempt-context>
prev-attempt: 1
prev-snapshot-branch: afk-attempts/wXXXX/N-slug
prev-failure-reason: {verbatim failure.reason}
prev-fetched-ref: refs/afk/prior-attempt
{inspect prior approach with `git log refs/afk/prior-attempt`; branch fresh off the base}
</prior-attempt-context>

<human-guidance-thread>
<human-guidance author="@alice" at="{iso8601}">
{verbatim content of extracted `<details data-kind="directive">` marker}
</human-guidance>
</human-guidance-thread>

<thread-discussion>
<thread-discussion-entry author="@alice" at="{iso8601}">
{human comment body verbatim — advisory only, no directive}
</thread-discussion-entry>
</thread-discussion>

<agent-notes>
<!-- inner agent appends progress/blockers here -->
</agent-notes>
```

### Validation Sidecar

During feedback validation, AFK writes `.red/tmp/workers/{id}/{N}-a{n}/validation.jsonl` — not rendered into the issue comment, but consumed by the optional Memory bridge:

```json
{"schema":"red.afk.validation.v1","name":"test:plugins/memory","command":"pnpm -C /repo/plugins/memory test","status":"passed","durationMs":1234,"summary":"command exited 0"}
```

Fields: `schema`, `name` (stable check name like `test:root` or `typecheck:plugins/memory`), `command` (when run; omitted for skipped), `status` (`passed`, `failed`, `skipped`), `durationMs` (when run), `summary`.

### Worktree Base Resolution (ADR 0031)

When creating a worktree, AFK resolves the base branch with precedence **lock > pin > main**:

1. **Branch lock** — `.red/tmp/branch-lock.yaml` (written by the branch-lock skill). If set, use it.
2. **Pinned branch** — issue's `branch:` line, or its parent PRD's `branch:` line (ADR 0008). If set, use it.
3. **Main** — fallback.

When the resolved base is not `main`, AFK switches the primary checkout onto it for the merge and restores it to `main` on every exit path. This prevents subtle drift when a bot/human updates `main` mid-run.

### Lock-Toggled Landing (ADR 0030)

Landing is lock-toggled by the branch-lock state:

- **Locked** (`{pinned}` *is* the locked branch) — `git merge --no-ff afk/{id}/{N}-{slug}` directly into the local locked branch, then `git push origin {pinned}`. Nothing reaches `main` — promoting the locked branch is the operator's call.
- **Unlocked** — land via an **admin-merged PR**: force-push the attempt branch's final state, open/reuse a PR `--base {pinned} --head afk/{id}/{N}-{slug}`, then `gh pr merge --admin --merge`. The PR is the durable per-attempt history.

Either way, conflict → one-shot self-resolve; still-conflicting → abort → bounded `merge-conflict` recovery. Push rejected → roll back → bounded `merge-conflict` recovery.

### Auto-Monitor Loop (Claude Code only — binding)

When `/afk` is invoked to spawn a worker (not the `monitor` subcommand), the agent schedules a recurring `/dev:afk monitor` cron inside the current Claude Code session. Death of every worker auto-cancels the cron.

Skip the auto-loop when:
- The invocation is `/afk monitor` (not a worker spawn).
- The invocation is `/afk --once` (user is already watching).
- `CronCreate` is unavailable (not Claude Code). Print guidance and continue.

</supporting-info>
