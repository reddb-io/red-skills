---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a PRD, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--prd N | --issues N,N,N] [--runner claude|codex|opencode] [--alternate] [--fallback-runner] [--request TEXT] [-n N] [--once] [--boot-only] | fleet [N] | fleet stop | monitor | dashboard | daily-review | weekly-review | retake N | reap"
---

# /afk

**Read, don't reverse-engineer.** This SKILL.md is the contract; source is build artifact.

Drain the agent-ready backlog. Single skill that owns issue selection, worktree isolation, inner-agent execution, GitHub state coordination, merge-back, and runner-fallback.

## Runtime & Invocation

> **Run this skill — do not read its code.** This `SKILL.md` is the complete behavioural contract. The `bin/` bundle and the `scripts/` shell files are **build/runtime artifacts**, not documentation: opening them to "understand what `/afk` does" wastes context and is never required. Everything an agent needs to operate `/afk` is in this file.

The skill ships a single committed runtime bundle. Invoke it as:

```
RED_AFK_RUNNER=<claude|codex> node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" <command> [params]
```

The invoking LLM is responsible for setting `RED_AFK_RUNNER` to its own host runner (`codex` from Codex, `claude` from Claude Code). Do not infer a different runner from binaries on `PATH`; use `--runner` only when the user explicitly pinned one.

`afk.mjs` is a **dedicated forwarder** (ADR 0039 entrypoint, build role `run:dev`): every argument is passed straight to the `dev` bundle, whose own command surface (`run`, `monitor`, `fleet`, …) is documented below. So `… afk.mjs run --once`, `… afk.mjs monitor`, and the bare `… afk.mjs --issues 42` all reach the orchestrator. The generic entrypoint verbs (`run <plugin>` / `fetch`) belong to `red-fetch.mjs`, not to this launcher — they do **not** shadow the bundle's commands (#434).

Commands and their parameters are documented in *When To Use* below — that section is authoritative for the CLI surface. The commands are `run` (the default — a bare token routes here with argv preserved), `monitor`, `dashboard`, `daily-review`, `weekly-review`, `retake`, `fleet`, `reap`, `codex-statusline` (inspect/fix Codex's native footer widgets), `codex-monitor-agent` (emit the read-only Codex monitor-agent prompt for host-layer spawning), `statusline` (the shared RedSkills statusline producer for command-backed host adapters; reads the host payload on stdin and resolves the project root from `$1` or the payload), and the hidden `__supervise` (the fleet supervisor entrypoint; never invoked by hand). `run` accepts `--prd`, `--issues`, `--runner`, `--alternate`, `--fallback-runner`, `--request`/`-r`, `-n`, `--once`, and `--boot-only`; `monitor` accepts `--once`; `dashboard` accepts `--period N|Nd` and `--json`; `daily-review` and `weekly-review` accept `--json`; `retake` accepts `#ISSUE`, `--apply`, `--json`, `--repo OWNER/REPO`, and `--pr-limit N`; `fleet` accepts an optional numeric target `N`, the `stop` subcommand, `--request`/`-r`, and `--runner`; `reap` takes no flags; `codex-statusline` accepts `--config`, `--fix`, and `--json`; `codex-monitor-agent` accepts `--project-root`, `--mode run|fleet`, `--interval-seconds`, and `--json`; `statusline` accepts an optional project-root path as `$1`.

The bundle is a single self-contained build (one file, one inlined runtime dependency, no `node_modules`, no install step) and is the public entrypoint. Every command — orchestration, supervisor, statusline, and hooks — executes natively in the bundle; the legacy shell orchestrator under `scripts/` has been removed (ADR 0032, ADR 0034). Treat this `SKILL.md` as the contract: run the bundle, don't read its source.

## Execution Substrate (ADR 0033)

The per-issue **agent run** executes on [`@reddb-io/red-castle`](https://github.com/reddb-io/red-castle) — reddb.io's vendored sandcastle fork, a `packages/red-castle` submodule consumed as source (ADR 0061) — not on a hand-rolled `claude -p` / `codex exec` session whose stdout is grepped for stage transitions. The boundary is clean: **the substrate owns execution, AFK owns the issue policy**.

- **sandcastle** (one `run()` call per attempt) spawns the inner agent, creates and manages the git worktree, runs the configured sandbox, captures the agent's stream, detects the completion signal, and lands the agent's commits on the worker branch.
- **AFK** keeps everything around that call: issue selection, the three-layer claim, the handoff file, the package-aware feedback gate, lock-toggled landing (ADR 0030), base resolution (ADR 0031), the terminal-event envelope, close, and the boot/monitor/mirror sweeps.

AFK drives the sandcastle Orchestrator through **injected providers** (`SandcastleDeps`: `run`, `agentFor`, `sandboxFor`) so the single adapter module is the only code coupled to the package. The pure mapping (`buildRunOptions` → `RunOptions`, `interpretOutcome` → outcome) is unit-tested with `run` injected; the real providers are wired lazily once, on the first agent run, so a `monitor` / `reap` / empty-queue path never imports sandcastle. AFK's canonical sentinels `<promise>DONE</promise>` and `<promise>BLOCKED</promise>` are registered as sandcastle `completionSignal`s, so the [`AGENT-PROMPT.md`](AGENT-PROMPT.md) contract is unchanged — the agent still authors its own exit.

`run()` returns `{ branch, commits, completionSignal }`; AFK maps `completionSignal` to an outcome (`done` / `blocked` / `no-sentinel`) and proceeds with its own feedback → landing → envelope → close. Execution is a **single `runAgent` call**, not a multi-mode dispatch over named run-modes.

## When To Use

- `/afk` — every issue currently labelled `ready-for-agent`.
- `/afk --prd 42` — only issues that reference PRD #42 (by `prd: #42` line in body, parent link, or `prd:42` label).
- `/afk --issues 356,359,362` — explicit list, in that order.
- `/afk --runner codex` — pin a backend (disables detection cascade; mutually exclusive with `--alternate`).
- `/afk --alternate` — opt in to round-robin runner rotation between issues (claude → codex → claude → …).
- `/afk --fallback-runner` — opt in to swapping runners mid-issue when one returns `RUNNER_EXHAUSTED`. Without this flag, exhaustion routes the issue through bounded `blocked:quota` recovery and stops the outer run with exit 75.
- `/afk --request "dont run cargo tests for this issue resolution"` or `/afk -r "..."` — add a special user request block to every inner-agent prompt for this run.
- `/afk -n 5` — cap at five issues. `-n N` caps the run at `N` issues; `-n 0` (and omitting `-n`) drains the whole queue until it is empty (`0` means unlimited, not zero). For a no-agent dry-run use `--boot-only` instead.
- `/afk --once` — single supervised iteration. Use for debugging the prompt.
- `/afk --boot-only` — run the boot sweeps then exit without claiming or spawning an agent; a safe dry-run to inspect bootstrap / orphan-cleanup / unblock-sweep / precheck.
- `/afk monitor` — readonly status board, aggregates every `.red/tmp/workers/*/*/afk.state.json` so you see all live workers from another terminal. **Also (binding):** mirrors live workers onto the host runner's native task surface — `TaskCreate`/`TaskUpdate` under Claude Code, the sub-agent surface under Codex when present (falls back to the dashboard otherwise). See *Task Mirror* below — this is not optional and you must do it on every tick, even when the user only asked "como estamos?".
- `/afk dashboard [--period 30d] [--json]` — readonly process dashboard: open PRDs/issues, global `running` issues, local AFK workers on this machine, issue/PR flow metrics, and DORA proxy metrics.
- `/afk daily-review [--json]` — readonly daily operational review from yesterday local midnight to now: delivery big numbers, local worker attempts/time, token spend when available, HITL/blocker challenges, and issue/PR cycle times.
- `/afk weekly-review [--json]` — readonly six-day operational review from six-days-ago local midnight to now, with the same sections as `daily-review`.
- `/afk retake 123 [--apply] [--json]` — issue resumption report: reads the issue, linked PRs, matching local/remote branches, matching local worktrees, HITL state, and prints the next command to continue, fix, recreate a ship worktree, or run `/ship`. With `--apply`, executes only safe local setup `git` operations and still leaves merges/HITL to `/ship` or `/hitl`. The parser accepts `#123` too; quote it when invoking through a shell.
- `/afk fleet [N]` — launch the supervisor maintaining `N` concurrent workers (default `2`). See *Fleet Mode* below.
- `/afk fleet stop` — gracefully shut down a running fleet supervisor and cancel its auto-monitor cron.
- `/afk reap` — run branch hygiene without starting a worker: one count line for remote `afk/*`, remote `afk-attempts/*`, and local `afk/*`, then the same safe reapers used at boot.

### Running `/afk` in an execution environment (GitHub Actions)

The same `/afk --issues N --runner opencode --once` command runs unchanged in a
GitHub Actions runner — one attempt, one issue, one PR per invocation, no fleet,
no admin-merge. Only the trigger and the secret-injection surface differ.

The lane is packaged as three layers (ADR 0059/0062): the reusable workflow
`.github/workflows/reusable-afk-attempt.yml` (triggers + trust gate) → the composite
action `.github/actions/afk-attempt` (execution) → the `afk.mjs` launcher +
Release bundle (runtime). Two adoption paths: **turnkey** (call the reusable) or
**composable** (`uses: reddb-io/red-skills/.github/actions/afk-attempt@v1` with
your own triggers/gate). Pin `@v1`/SHA for reproducibility. The composite action
carries its own red-skills checkout, so the launcher resolves in any adopter repo
— no workspace build, no submodule.

Triggers: `issues: labeled`/`opened` (on `ready-for-agent`), `workflow_dispatch`,
`workflow_call`. Trust gate (ADR 0056): author + label-actor must both be
allowlisted. Runner: opencode (API-auth); point it at OpenAI/MiniMax/OpenRouter
by wiring the matching key + a `<provider>/<model>` slug via the `model` input.

**→ Full adopter guide:
[`actions-lane.md`](./actions-lane.md)** (architecture, both examples, all
inputs, triggers, trust gate, auth precedence, the MiniMax recipe, permissions).

The k8s job manifest + real-environment E2E remain tracked as
[#631](https://github.com/reddb-io/red-skills/issues/631) (ADR 0059).

## Parallelization

`/afk` is **trivially parallel** — just open another terminal and run `/afk` again. No flag, no coordination, no slot to manage.

```bash
/afk            # terminal A → spawns worker "wZ2R4"
/afk            # terminal B → spawns worker "wK7M2"
/afk            # terminal C → spawns worker "w9RQP"
```

Each invocation generates its own **worker ID** — literal `w` plus 4 random characters from `[A-Z0-9]` (e.g. `wZ2R4`, ~1.7M possible IDs) — and uses it as the prefix for every per-run file. The leading `w` makes the worker directory `.red/tmp/workers/{id}` an unambiguous live-worker anchor. The ID is printed on the first line of the run so you can tail or kill it later.

Per-attempt files live under `.red/tmp/workers/{id}/{N}-a{n}/` in the primary checkout, where `{id}` is the worker ID, `{N}` is the issue number, and `{n}` is the per-issue attempt counter (derived by the attempt-ledger — every retry, even by a different worker, gets a fresh `a{n}` directory). Everything for one (worker, issue, attempt) is in one directory — when the attempt ends successfully the whole directory is removed; when it blocks the whole directory is preserved. The worker also holds a single per-worker liveness anchor at `.red/tmp/workers/{id}/worker.pid` (see the `worker.pid` row below).

| Path | Purpose |
|---|---|
| `.red/tmp/workers/{id}/worker.pid` | Per-worker liveness anchor: the orchestrator's PID, written **once at bootstrap** and removed on the worker's EXIT trap (along with rmdir of the empty worker dir). The single liveness anchor for the worker; the fleet supervisor's slot matching keys off it. |
| `.red/tmp/workers/{id}/{N}-a{n}/worktree/` | Git worktree for issue `N` on attempt `n`. Lives inside the gitignored `.red/tmp/` so it never pollutes sibling directories. |
| `.red/tmp/workers/{id}/{N}-a{n}/afk.log` | Append-only plain log for this attempt (orchestrator output + inner-agent stdout + heartbeat lines). Per-attempt scope — each attempt gets a fresh log. |
| `.red/tmp/workers/{id}/{N}-a{n}/agent.log.jsonl` | Clean **agent lane** (issue #250) — one `type=agent` JSONL record per assistant turn and nothing synthetic, so it is the true liveness signal and reads as a live transcript: `tail -f … \| jq -r .msg`. Single-writer. |
| `.red/tmp/workers/{id}/{N}-a{n}/log.jsonl` | The **firehose** (issue #250) — every record of the attempt in the uniform JSONL envelope: agent turns, heartbeat vitals, hook dispatches, runner timings, and errors. Flock-serialised (many concurrent writers). |
| `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json` | State snapshot for this attempt. Schema in [`docs/ENVELOPE.md`](./docs/ENVELOPE.md). |
| `.red/tmp/workers/{id}/{N}-a{n}/handoff.md` | Handoff file the inner agent reads — `<issue-body>` (issue body verbatim, including the `## Agent brief` markdown section), `<previous-attempts>`, `<human-guidance-thread>` (one `<human-guidance>` per extracted directive), `<thread-discussion>` (advisory comments with no directive marker), `<agent-notes>`. Top-level XML wrappers make body/comments/notes unambiguous. Template in [`docs/HANDOFF.md`](./docs/HANDOFF.md). |

Two workers cannot claim the same issue thanks to a local `mkdir` lock at `.red/tmp/claims/{N}/` plus a `gh issue view` pre-check before the edit. The gh edit itself is not atomic (see *Issue Lifecycle* below for the full three-layer scheme). The race surface is the brief window between two separate checkouts on the same host — acceptable for the intended scale.

## Hard Preconditions

Refuse to start if any fail — the user fixes them.

- `git remote -v`: SSH only. Reject HTTPS — never auto-rewrite.
- `gh auth status` succeeds.
- Repo has `main` branch: `git -C primary log -1 main` works.
- Label `ready-for-agent` exists; if not, point at `/triage`.
- `pnpm` is on PATH.

## Bootstrap

Run before the first iteration:

1. Ensure `.red/tmp/` exists (create) and in `.gitignore` (append if missing).
2. **Generate worker ID:** `w` + 4 random `[A-Z0-9]` chars (e.g. `wZ2R4`). Regenerate on live-directory collision. Print `worker: {id}` first.
3. **Detect runner** (first wins; log `runner: <r> (detected via <method>)`). Load the matching runner doc. Never probe `command -v`; swap only via `--fallback-runner`.
   - `--runner X` pin (`opencode` valid only here or via env) → `RED_AFK_RUNNER` env → env-var sniff (`CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`/`CLAUDE_CODE_SSE_PORT` → `claude`; `CODEX_HOME`/`CODEX_SANDBOX`/`CODEX_SANDBOX_NETWORK_DISABLED`/`CODEX_MANAGED_BY_NPM` → `codex`) → process-tree → path (`~/.claude/` → `claude`; `~/.codex/` → `codex`) → default `claude`.
4. Read [`SAFETY.md`](SAFETY.md) — binding for every shell action.
5. **Write `worker.pid`:** create `.red/tmp/workers/{id}/`, write current PID **once** — the worker's liveness anchor for its whole lifetime.
6. Install signal handlers (SIGINT/SIGTERM/EXIT): release claim, preserve attempt dir, remove `worker.pid`, rmdir empty worker dir.

## Boot-time sweeps

At boot the bundle reclaims stale state — orphan attempt dirs (issue-state TTL), the per-issue attempt cap (#257), the `afk-attempts/*` snapshot-branch grace cleanup (#258), and the on-demand `/afk reap` branch reaper (#275). Mechanics: [`docs/BOOT-SWEEPS.md`](./docs/BOOT-SWEEPS.md).

## Dependency Unblock — `req:N` edges, close cascade + boot sweep

Dependencies are first-class **`req:N` edge labels** (one per blocker), and a dependency-blocked issue holds the **`blocked:dependency`** state — *not* `ready-for-human` (it is healthy, waiting, and never pages). Two mechanisms promote it to `ready-for-agent`:

**1. Close cascade (event-driven, the fast path).** Immediately after `/afk` closes an issue #N on the DONE path (after the completion sweep), it re-evaluates every dependent of #N:

1. `gh issue list --label req:N --state open --json number,labels`.
2. For each dependent, read its `req:*` labels and resolve each referenced issue's state (the just-closed #N is known closed; others via a cached lookup).
3. When **every** `req:*` of a dependent is now closed: `gh issue edit --remove-label blocked:dependency --add-label ready-for-agent` + post `🤖 /afk unblocked: all dependencies closed (#…)`.

Best-effort: a `gh` failure here logs a `warn:` and never fails the close — the boot sweep below catches anything the cascade missed.

**2. Unblock Sweep (boot-time, the safety net).** After [orphan cleanup](./docs/BOOT-SWEEPS.md) and before *Straggler Check*, `/afk` re-scans dependency-blocked issues by label and promotes any whose deps all closed:

1. `gh issue list` for open `blocked:dependency` issues with `number,labels,body`.
2. Deps come from the `req:*` labels (the source of truth); for pre-`req:N` issues with no such label, fall back to extracting `#N` refs under the literal `## Blocked by` body heading (`- [ ] #N`) only when the issue is still labelled `blocked:dependency`.
3. Resolve each dep via `gh issue view <N> --json state`; promote only when **every** dep is `CLOSED`.
4. On promotion: remove the holding label (`blocked:dependency`), add `ready-for-agent`, post the audit comment, and log `unblocked N issue(s): #A #B`.

`ready-for-human` is a human gate, not dependency-wait. The boot sweep must not promote it from a legacy `## Blocked by` body parse, because a closed blocker can still encode a failed measurement or a no-go decision. `blocked:dependency` issues do not have that ambiguity: the label *means* dependency-wait, which is the whole point of separating it from `ready-for-human`.

## Current Blocker State

Human gates are first-class issue-body state, not implicit thread archaeology. Before claiming an issue, `/afk` checks for an active `## Current blocker` block:

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

If this block is present with `status: blocked`, `/afk` does not create an attempt. It removes `ready-for-agent`, adds `ready-for-human` plus the typed blocker label, leaves the issue open, and waits for `/hitl`.

When an attempt escalates to a terminal human page (for example BLOCKED, validation failure, non-recoverable stall/infra, or a recoverable reason after retry-budget exhaustion), the runtime writes or replaces this block so the next `/hitl` turn can start from the current blocker instead of re-reading every old envelope. `/hitl` clears the block to `None`, records it under `## Resolved blockers`, refreshes `## Agent brief`, and moves the issue back to `ready-for-agent` only when the next agent can continue without guessing.

Use `## Blocked by` only for mechanical dependencies that should auto-promote on close. Use `## Current blocker` / `## Human decision needed` for gates, measurements, product calls, or any state where "the referenced issue closed" is not enough to prove the work is delegable.

## Straggler Check

Before issue selection, `/afk` counts open issues in states it cannot consume:

- `unlabeled` — never triaged
- `needs-triage` — triage in progress
- `needs-info` — waiting on reporter

If any of those are non-zero, print a warning and (on a TTY, not in `--once`) prompt to confirm before proceeding. This catches the "issue perdida" case where a fresh report never made it through `/triage` and is silently invisible to `/afk`.

The systemic fix is the `red-issues-needs-triage.yml` workflow installed by `/setup-red-skills`, which auto-applies `needs-triage` to every fresh issue. The straggler check is the in-loop safety net for repos where the workflow isn't installed yet.

## Issue Selection

Pull: `gh issue list --label ready-for-agent --state open --json number,title,labels,body --limit 100`. Drop every `type:prd` issue before any filter (log `/to-issues N` warning for each). Prepend `priority:urgent` issues before any filter, oldest first.

Filters for the **non-urgent remainder**:
1. `--issues N…`: keep those numbers in argument order; error if missing or not `ready-for-agent`; PRDs rejected.
2. `--prd N`: keep issues with `prd: #N` in body, parent link, or `prd:N` label; PRD itself excluded.
3. Default: all remaining `ready-for-agent`, `priority:high` first, then ascending by number.

Final queue: `[urgent…] + [filtered…]`, deduped. Empty → `<promise>NO MORE TASKS</promise>`, exit 0.

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
   │       └──── terminal failure
   │                   │
   │              classify Attempt Outcome
   │              add typed blocked:<reason>
   │                   │
   │          ┌────────┴────────┐
   │          │                 │
   │          │ recoverable and │ non-recoverable, or
   │          │ attempt < cap   │ recoverable at/over cap
   │          │                 │
   │          ▼                 ▼
   │     remove running    remove running
   │     add               add
   │     ready-for-agent   ready-for-human
   │     post/retry        post blocker/budget
   │     audit             exhausted comment
   │          │                 │
   │          ▼                 ▼
   │     ready-for-agent   ready-for-human
   │     (fresh attempt)   (human gate)
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
3. **Stale-lock sweep** at boot, during orphan cleanup — any `.red/tmp/claims/{N}/` whose recorded pid is dead gets reclaimed automatically.

Residual gap: two clones of the same repo on the same host (or different hosts) do not share `.red/tmp/`, so each holds its own mkdir lock and the gh edit race re-opens for the brief window the pre-check leaves uncovered. Acceptable for the intended scale (a few terminals, one checkout). If you need cross-host claim safety, gate `/afk` on a proper coordinator instead of GitHub labels.

### Typed Failure Labels And Recovery Caps

AFK labels terminal failures with a descriptive `blocked:<reason>` label in addition to the routing label. The typed label is observability: a retry path still adds `ready-for-agent`, and an escalated path still adds `ready-for-human`.

| Attempt Outcome | typed label | recovery policy | default cap |
|---|---|---|---|
| `exhausted` | `blocked:quota` | `quota` | `RED_AFK_RETRY_QUOTA=3` |
| `runner-transient` | `blocked:runner-transient` | `runner-transient` | `RED_AFK_RETRY_RUNNER_TRANSIENT=3` |
| `merge-conflict` | `blocked:merge-conflict` | `merge-conflict` | `RED_AFK_RETRY_MERGE=3` |
| `ci-failed` | `blocked:ci` | none — escalates to a human/CI-aware finisher (never re-runs the agent) | n/a |
| `ci-pending` | `blocked:ci` | none — escalates to a human/CI-aware finisher (never re-runs the agent) | n/a |
| `no-sentinel` | `blocked:crashed` | `crashed` | `RED_AFK_RETRY_CRASH=1` |
| `hook-aborted` | `blocked:policy` | `policy` | `RED_AFK_RETRY_POLICY=1` |
| `blocked` | `blocked:spec` | none — escalates immediately | n/a |
| `feedback-failed` | `blocked:validation` | none — escalates immediately | n/a |
| `stalled` | `blocked:stalled` | none — escalates immediately in the per-issue path | n/a |
| `infra` | `blocked:infra` | none — escalates immediately | n/a |
| `done` / `claim-lost` | none | none | n/a |

Recoverable reasons retry while the 1-based attempt number is less than the cap. At the cap and above, the same reason escalates to `ready-for-human`, keeps the typed `blocked:<reason>` label, and posts a retry-budget-exhausted comment. Missing, non-numeric, zero, or negative `RED_AFK_RETRY_*` values fall back to the default cap.

**`blocked:ci` never re-runs the agent (#812).** On an `enforce_admins` base, an admin-merge cannot bypass required status checks, so a completed, MERGEABLE PR whose required checks **failed** (`ci-failed`) or are still **pending** past the CI-wait timeout (`ci-pending`) is **not** a merge conflict. These outcomes carry `blocked:ci` and escalate straight to `ready-for-human` with the **PR left open** — they are deliberately NON-recoverable so AFK never re-runs the whole inner agent (re-spending tokens) for work that is already done and only awaiting CI. A human / CI-aware finisher drives the existing PR to merge once CI is green. This is gated by `afk.merge.ci_aware` (see step 8); with it off, the unlocked path admin-merges immediately (correct only on a base with no required checks).

## Per-Issue Loop

For each issue `N`:

1. **Claim.** `gh issue edit N --remove-label ready-for-agent --add-label running`. Then resolve the attempt number `{n}` from the attempt-ledger (per-issue across all workers), create the attempt directory `.red/tmp/workers/{id}/{N}-a{n}/`, open `afk.log` (tee target for orchestrator output), and initialise `afk.state.json` per [`docs/ENVELOPE.md`](./docs/ENVELOPE.md). The orchestrator PID is already recorded once in the per-worker `worker.pid` (written at bootstrap) and is also embedded in `afk.state.json`'s `.pid` field — there is no per-attempt pid file. Comment a start line on the issue: ISO timestamp, runner identity, worktree path. If labelling fails because someone else already claimed it, abandon the attempt directory and skip to the next issue.
2. **Worktree.** Resolve the **base branch** with precedence **lock > pin > main** (ADR 0031): the primary checkout's branch-lock value (`.red/tmp/branch-lock.yaml`, written by the branch-lock skill) wins when set; else the **pinned branch** (ADR 0008 — the issue's own `branch:` line, else its parent PRD's); else `main`. (`{pinned}` below denotes this resolved base.) Then `git -C primary fetch origin {pinned}` and `git worktree add .red/tmp/workers/{id}/{N}-a{n}/worktree -b afk/{id}/{N}-{slug} origin/{pinned}` from the primary checkout. The worktree lives inside the gitignored `.red/tmp/` tree so it never appears in `git status` for `main`. Immediately after worktree creation the runtime mirrors the new branch on origin (`git push origin -u HEAD:refs/heads/afk/{id}/{N}-{slug} --force-with-lease`) and installs a per-worktree `post-commit` hook that fire-and-forgets a `git push origin HEAD --force-with-lease` after every inner-agent commit. Both calls are best-effort: a network/auth failure logs a `warn:` line and the iteration continues — the `afk-attempts/*` failure-push net (see [`docs/ENVELOPE.md`](./docs/ENVELOPE.md)) still fires on terminal failure. Net effect: `afk/{id}/{N}-{slug}` is a **remote-tracked branch throughout the iteration**, so a SIGKILL anywhere from here on preserves the diff on origin without manual recovery.
3. **Handoff file.** Materialise the handoff into `.red/tmp/workers/{id}/{N}-a{n}/handoff.md` using the template below — top-level XML wrappers (`<issue-body>`, `<previous-attempts>`, `<prior-attempt-context>`, `<human-guidance-thread>`, `<agent-notes>`) keep the issue body, orchestrator-authored prior attempts, the restart-informed retry block, human comments, and the inner-agent scratchpad unambiguous. `<issue-body>` carries the issue body verbatim (including the `## Agent brief` section written by `/triage`). The handoff file lives one level above the worktree so the inner agent reads it via `../handoff.md` from inside the worktree, and so it survives a worktree wipe on retry.
   - **Restart-informed retries (PRD #244, issue #255).** On a terminal failure the orchestrator writes two marker files into the failing attempt dir: `snapshot-branch.ref` (the `afk-attempts/{id}/{N}-{slug}` ref it pushed to) and `failure.reason` (the envelope summary). On the **next** attempt — the runtime reads those markers *before* the current attempt dir is created, so it sees the prior attempt's state — the handoff builder fetches that snapshot branch into the worktree under the local ref `refs/afk/prior-attempt` and emits a `<prior-attempt-context>` element carrying `prev-snapshot-branch`, the verbatim `prev-failure-reason`, and `prev-fetched-ref`. The retry still branches **fresh off the base** (step 2 is unchanged), so a wrong prior approach never compounds; the fetched ref is read-only history for the inner agent to inspect. First attempts skip all of this and are byte-for-byte unchanged.
4. **Local heartbeat marker.** Write one `[heartbeat] iteration started for #N` line to `afk.log`. Slice D retired the periodic GitHub-comment heartbeat (`:one: :two: :three: :four:`) — local liveness is now signalled by the inner-agent stdout stream tee'd into `afk.log` plus state-file mtime, both of which already exist.
5. **Inner agent.** Drive the inner agent via the single sandcastle `runAgent` call (ADR 0033, *Execution Substrate* above): the handoff file is the `promptFile`, the resolved runner/model selects the provider, the resolved sandbox mode selects the isolation backend, and the worker branch is the `branchStrategy` target forked off the base resolved in step 2. The optional `--request/-r` special user request block is materialised into the handoff. sandcastle captures the agent's stream (surfaced through the `onAgentStreamEvent` callback, which AFK fans out to `agent.log.jsonl` + the firehose) and detects the `<promise>DONE|BLOCKED</promise>` completion signal; AFK reads stages off that stream — see [`docs/ENVELOPE.md`](./docs/ENVELOPE.md). The call's termination bounds (`idleTimeoutSeconds`, `maxIterations`, and the commit-anchored attempt guard) are documented under *Attempt Completion & Termination Bounds*.
6. **Inner result.**
   - Inner committed and emits `<promise>DONE</promise>` → continue to feedback loops.
   - Inner emits `<promise>BLOCKED</promise>` plus notes appended to the handoff file → comment the blocker on the issue, re-label `ready-for-human`, drop the worktree, go to next issue.
   - Inner emits `<promise>NO MORE TASKS</promise>` from inside one iteration → ignored. That sentinel is for the outer loop.
   - Runner-exhausted signal (rate limit / quota error string per runner) → without `--fallback-runner`, terminate this issue as Attempt Outcome `exhausted`; route it through bounded recovery (`blocked:quota`, retry under `RED_AFK_RETRY_QUOTA`, escalate at/over cap). With `--fallback-runner`, keep the same worktree and handoff, swap runner once, and only route `exhausted` if the swapped runner also exhausts.
7. **Feedback loops.** In the worktree, derive relevant package scopes from the worker branch diff against the pinned base, then run `test`, `typecheck`, `lint`, and `build` with `pnpm -C <scope>` for each touched package that declares the script. Root-only repos keep using the root package. Any missing script is reported as an explicit per-scope skip in the validation section. Any failure blocks the merge and flips the issue to `ready-for-human` with the validation report in the blocker envelope.
8. **Merge.** All steps target the **base branch** resolved in step 2 (`{pinned}`, defaults to `main`). The integration prelude is shared; **landing is lock-toggled** by the branch-lock state (ADR 0030).
   - Primary dirty? Auto-stage and commit `chore(afk): pre-merge snapshot for #N` in primary. Never `git stash`. Never `git checkout -- .`.
   - `git -C primary fetch origin {pinned}`. The primary checkout is pinned to `main` by the precheck; when `{pinned}` is not `main`, switch the primary checkout onto it for the merge (creating the local branch from `origin/{pinned}` if needed) and **restore it to `main` on every exit path**.
   - **Integrate the fetched tip into local `{pinned}` before merging**: fast-forward when local is strictly behind, otherwise rebase local commits onto `origin/{pinned}`. Without this the worker branch merges onto the stale boot-time HEAD and the push is rejected non-fast-forward whenever origin moved mid-run. If integration fails (diverged history that won't rebase), abort the merge and route the `merge-conflict` outcome through bounded recovery.
   - Capture the integrated tip (`pre_merge_sha`) for rollback, then land per lock state:
     - **Locked** (`.red/tmp/branch-lock.yaml` present — `{pinned}` *is* the locked branch): `git -C primary merge --no-ff afk/{id}/{N}-{slug} -m "merge: #{N} {title}"` directly into the local locked branch, then `git -C primary push origin {pinned}`. **Nothing reaches `main`** — promoting the locked branch to `main` is the operator's call. Conflict → one-shot self-resolve; still-conflicting → `git merge --abort` → bounded `merge-conflict` recovery. Push rejected → roll back to `pre_merge_sha` → bounded `merge-conflict` recovery.
     - **Unlocked**: land via an **admin-merged PR**. Force-push the attempt branch's final state to origin, open (or reuse) a PR `--base {pinned} --head afk/{id}/{N}-{slug}`, then `gh pr merge --admin --merge`. The **PR is the durable per-attempt history** — it survives the branch deletion in step 11. No completed work reaches `{pinned}` except through this admin-merge. Then fast-forward local `{pinned}` to the PR merge commit so the closing envelope's `merge_sha` is correct.
       - **CI-aware merge (#812, `afk.merge.ci_aware: true`).** On an `enforce_admins` base the admin-merge **cannot** bypass required status checks, so admin-merging a just-opened PR with checks pending is rejected. When `ci_aware` is on, after opening/reusing the PR **poll `gh pr view --json mergeStateStatus,statusCheckRollup`** on a bounded loop (budget `RED_AFK_MERGE_CI_TIMEOUT_S`, default 1800s) until the PR settles, then `gh pr merge --admin --merge` **only** once `mergeStateStatus == CLEAN` (or it is `BLOCKED` solely by a required review, which `--admin` waives). Route the distinct failure modes instead of collapsing all to `merge-conflict`: a real git conflict / `DIRTY` / `BEHIND` → `merge-conflict` (bounded recovery — correct here); a **failed** required check → `ci-failed` (`blocked:ci`); checks still **pending** at the timeout → `ci-pending` (`blocked:ci`). `ci-failed`/`ci-pending` **leave the PR open** and escalate to `ready-for-human` — they never re-run the inner agent for already-complete work (see *Typed Failure Labels And Recovery Caps*). With `ci_aware` off (the default), a push/create/admin-merge failure routes through bounded `merge-conflict` recovery as before.
9. **Push.** Folded into step 8: the **locked** path pushes the locked branch over SSH (rollback on reject); the **unlocked** path's push *is* the admin-merge of the PR. Either way, do not retry-loop indefinitely.
10. **Close.** Validation comment on the issue: tests pass/fail, lint, typecheck, build, commits added, files touched. Then `gh issue close N --reason completed`. Remove `running` label. Once the close succeeds, delete the live remote branch (`git push origin --delete afk/{id}/{N}-{slug}`) so the remote graveyard stays tidy — the merge commit on `{pinned}` already carries the diff. Best-effort: a failed delete (branch protection, network) logs a `warn:` line and the close still completes; the orphan `afk/*` branch can be cleaned up later.
11. **Cleanup (split teardown, issue #256).** Every close path — success **and** failure/blocker — always drops the heavy worktree (`git worktree remove .red/tmp/workers/{id}/{N}-a{n}/worktree`) while **retaining** the cheap artifacts (the JSONL lanes `log.jsonl` / `agent.log.jsonl` and the `handoff.md`) in the attempt directory for post-mortem. On DONE the merged branch is also deleted (`git branch -d afk/{id}/{N}-{slug}`, after the worktree is gone). The retained attempt's state file is marked not-live (`pid: 0`) so monitor / mirror / statusline read it as finished. No worktree survives a close; the attempt dir itself is reclaimed later by the boot-time orphan sweep's TTL **or, on DONE, immediately by the completion sweep below**. The remote `afk/{id}/{N}-{slug}` ref was deleted in step 10 on DONE; failure paths leave the remote ref intact and instead push the canonical `afk-attempts/{id}/{N}-{slug}` ref (see [`docs/ENVELOPE.md`](./docs/ENVELOPE.md)).
    - **Completion sweep (issue #257).** Once an issue is closed and merged, the runtime reclaims **every** attempt dir for that issue across **all** workers via the canonical `.red/tmp/workers/*/{N}-a*` glob — not just the worker that completed it. The split-teardown retention only buys time for the orphan-sweep TTL; a completed issue needs none of it, so its retained dirs (including this worker's just-closed one) go now. A live worker's active attempt — one whose own state file still carries a live `pid` — is always skipped, though the claim lock makes a live duplicate of a just-completed issue unlikely.
12. **Tick.** Update state file. Recompute ETA from rolling average of last 3 issue durations. Print one summary line: `finished {done}/{total} ({pct}%) — next: #{next}`.

## Runner Fallback

Default behaviour is **no rotation and no fallback** — the runner resolved by the detection cascade (see *Bootstrap* step 4) is used for every issue in the run. `RUNNER_EXHAUSTED` is first handled as the per-issue Attempt Outcome `exhausted`: the issue gets `blocked:quota`, returns to `ready-for-agent` while under `RED_AFK_RETRY_QUOTA`, and escalates to `ready-for-human` at/over the cap. The outer session then stops the drain and returns exit 75 (`EX_TEMPFAIL`) so a supervisor can retry later instead of treating runner quota as a clean queue drain. Both rotation/fallback behaviours are opt-in:

- `--alternate` re-enables round-robin rotation between consecutive issues (claude → codex → claude → …). Mutually exclusive with `--runner`.
- `--fallback-runner` re-enables mid-issue swap when the active runner returns `RUNNER_EXHAUSTED`. Without it, exhaustion is terminal for the current runner invocation and routes through bounded recovery as `blocked:quota`.

 Exhaustion detection lives in [`runner-claude.md`](runner-claude.md), [`runner-codex.md`](runner-codex.md), and [`runner-opencode.md`](runner-opencode.md) — they own the per-runner error strings. The orchestrator only sees `RUNNER_EXHAUSTED` as a structured signal. Note `opencode` is an API-auth runner; the auth key rides in `OpenCodeOptions.env` and the model slug's leading segment (`openai/`, `minimax/`, `openrouter/...`) tells OpenCode which endpoint to dispatch to. See `runner-opencode.md` *Auth env precedence* for the env-var order (`OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`). In an API-key-only lane with no host session, run it without `--fallback-runner` so exhaustion is terminal-through-recovery rather than a swap to a session-auth runner that is not present.

When swap happens mid-issue (only with `--fallback-runner`), the same worktree and handoff file are reused; the new runner sees the previous agent's Notes appended.

## Attempt Completion & Termination Bounds (`<promise>` is canonical — ADR 0028)

The `<promise>…</promise>` sentinel the inner agent emits is the **canonical "attempt is over" signal**. AFK registers `<promise>DONE</promise>` and `<promise>BLOCKED</promise>` as sandcastle `completionSignal`s, so sandcastle stops re-invoking the agent the moment one is observed (line-anchored, so the agent quoting the sentinel in planning prose does not false-positive). sandcastle owns the stream read and signal detection — there is no hand-rolled foreground pipe reader, no recursive SIGTERM/SIGKILL of a `claude | jq | grep | tee` pipeline, and no `RED_AFK_ATTEMPT_GRACE_S` / `RED_AFK_ATTEMPT_KILL_S` / `RED_AFK_WATCHDOG_GRACE_S` tear-down knobs. This is the architecture fix flagged during the #216 bash-hang diagnosis ("a gente tem que ser mais sensível ao resultado da promise"): the completion signal is the terminator, and the substrate enforces it.

`runAgent` maps the returned `completionSignal` to an outcome: `<promise>DONE</promise>` → `done`, `<promise>BLOCKED</promise>` → `blocked`, no signal → `no-sentinel`. The completion signal is the **real** terminator — a normal issue finishes in 1-3 iterations — but three independent bounds cap a run that never signals so a stuck agent cannot burn cycles forever:

- **`idleTimeoutSeconds`** (default **600 s**, env `RED_AFK_IDLE_TIMEOUT_S`) — sandcastle's per-iteration **silence** watchdog: an iteration producing no stream output for this long is aborted. This is the actual termination bound on a quiet hang.
- **`maxIterations`** (default **12**, env `RED_AFK_MAX_ITERATIONS`) — the sandcastle Orchestrator **re-invocation** ceiling (issue #322). sandcastle's own default is 1, which would cut the agent off after a single agentic invocation before it can emit `DONE`; AFK raises it so the completion signal stays the terminator while bounding repeated no-sentinel failures. A non-numeric / zero / negative value (env or config) is ignored and falls back to the default, so a typo can never disable the cap or pin the agent to 1.
- **Commit-anchored attempt guard** (default **2700 s**, env `RED_AFK_ATTEMPT_TIMEOUT_S` / `afk.attempt_timeout`, ADR 0044/0045) — proof-of-**progress**: a run that stays *busy* (re-exploring, re-running tests) without landing a **new commit** within the cap is aborted, resetting on every commit. This catches the "productive infinite loop" that `idleTimeoutSeconds` misses because the agent is never silent. It maps to a `timeout` outcome → `blocked:stalled` / `ready-for-human`, preserving the worktree/PR. Armed **only under `none` (no-sandbox) isolation**, where the worker branch's commits land in the shared `.git` so HEAD advance is observable; under docker/podman the commits are not host-visible until final sync, so a commit-anchored guard would false-fire and is skipped (idle timeout + maxIterations still apply). The fleet hard **stall reaper** (see *Fleet Mode*) is separately gated by the active-`vitest`/`tsc`/`cargo`-descendant + flat-cpu predicate, so a worker mid-build/test is never killed for being idle on the agent lane.

**No sentinel is `on_attempt_error`.** When sandcastle's run completes with no completion signal, the agent never declared the attempt over (crash, kill, or a daemon that ended without speaking): the outcome is `no-sentinel`, `on_attempt_error` fires (error class `no-sentinel`), and `post_attempt` does **not** fire for that invocation. The issue routes through bounded `blocked:crashed` recovery. With the default `RED_AFK_RETRY_CRASH=1`, the first such failure escalates to `ready-for-human`; a higher cap can requeue it first. **Runner exhaustion** (`RUNNER_EXHAUSTED`, detected by matching the per-runner quota/rate-limit strings against the thrown sandcastle error) stays out of the sentinel channel — it keeps its own `exhausted` outcome and the `--fallback-runner` swap. A **transient runner transport/setup** failure maps to `runner-transient` and is bounded by AFK's retry policy rather than escaping as a crash.

The parsed outcome rides into the `post_attempt` mutable context as `result.outcome` and the `RED_AFK_RESULT_OUTCOME` env var, so hooks (and the Memory `attempt.hooks` record, #216) see the agent-authored exit, not just `success`/`fail`.

Preventive counterpart lives in [`AGENT-PROMPT.md`](AGENT-PROMPT.md) under *Background Tasks and Polling* — inner agents are required to cap every polling loop with a deadline. The termination bounds are the safety net; the prompt rule is the design.

## Liveness & stall protection

Local liveness = the clean `agent.log.jsonl` lane + the firehose + state-file mtime + a per-minute orchestrator heartbeat (the GitHub-thread heartbeat was retired in Slice D). A solo run is guarded by the commit-anchored attempt-progress guard (#400) and the lane-idle reaper (#363), both armed only under no-sandbox isolation. Details: [`docs/LIVENESS.md`](./docs/LIVENESS.md).

## Terminal-event envelope, stages & state file

Every terminal event posts exactly one structured `<details data-attempt-status=…>` comment (the canonical record). Stages are read off the sandcastle stream; the terminal header redraws every 3s; per-attempt state lives in `afk.state.json`. Schemas + the Attempt-Outcome→status mapping: [`docs/ENVELOPE.md`](./docs/ENVELOPE.md).

## Auto-Monitor Loop (Claude Code only — binding)

When `/afk` is invoked **to spawn a worker** (i.e., not the `monitor` subcommand), the agent additionally schedules a recurring `/dev:afk monitor` cron inside the current Claude Code session so the user sees progress without re-typing. Death of every worker auto-cancels the cron.

**Setup (runs immediately after the `run` worker is launched in the background):**

1. Fetch `CronCreate` and `CronList` via `ToolSearch` if not already loaded (they are deferred tools).
2. `CronList` — if any existing job has `prompt == "/dev:afk monitor"`, **skip step 3** (don't double-schedule when the user runs a second parallel `/afk` in the same session).
3. `CronCreate(cron="*/10 * * * *", prompt="/dev:afk monitor", recurring=true)`. The cron is session-only — it dies when the Claude Code session ends, so no risk of orphans across sessions. Auto-expires after 7 days regardless.
4. Tell the user **one line**: `monitor loop scheduled (every 10 min) — auto-cancels when all workers exit.`

The monitor invocation handles its own teardown — see *Self-Cancel* under the Monitor section below.

**Skip the auto-loop when:**

- The invocation is `/afk monitor` (not a worker spawn).
- The invocation is `/afk --once` (single supervised iteration; user is already watching).
- `CronCreate` is unavailable (not running under Claude Code — e.g. Codex). Print one line `monitor loop unavailable in this runner; tail .red/tmp/workers/*/*/afk.log manually.` and continue.

## Codex Monitor Agent (Codex only — binding)

Codex does not expose Claude Code's `TaskCreate` / `TaskUpdate` task surface, and
its `tui.status_line` only renders built-in footer widgets. It does expose a
native sub-agent UI in hosts where the sub-agent primitive is available. For
Codex runs, use that sub-agent UI as a read-only presentation layer over the
canonical `/afk monitor` dashboard.

When `/afk` launches a normal detached worker under Codex (`run`, not
`monitor`, not `--once`, not `--boot-only`):

1. Fetch a sub-agent spawn primitive via `ToolSearch` (query:
   `spawn agent background monitor`).
2. If unavailable, continue the worker launch and print:
   `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/workers/*/*/afk.log manually.`
3. If available, emit the canonical prompt from the bundle:
   ```bash
   RED_AFK_RUNNER=codex node "$CODEX_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" codex-monitor-agent --project-root "$PWD" --mode run
   ```
   Spawn exactly one monitor agent with that prompt. The monitor agent is a
   presentation consumer only: it periodically runs `/dev:afk monitor --once`,
   reports concise progress in the Codex UI, and exits once no supervisor or
   live workers remain.
4. Tell the user one line:
   `Codex monitor agent spawned — auto-closes when AFK exits; manual monitor: /dev:afk monitor.`

Hard boundaries for the monitor agent are non-negotiable: it must never edit
files, claim issues, change labels, comment, stop workers, run validation, push,
merge, `/ship`, `/hitl`, `/triage`, `/afk run`, `/afk fleet`, `/afk fleet stop`,
`/afk reap`, or `/afk requeue`. Closing it manually must not affect the AFK
worker.

## Fleet Mode (runner-portable — binding)

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are the user-facing fleet commands. They let one terminal command spin up (or shut down) `N` concurrent `run` workers on the current checkout, with the supervisor handling respawn, the circuit breaker, the **passive stall detector** (samples each slot's per-attempt **agent lane** `agent.log.jsonl` mtime — the clean liveness signal — every `RED_AFK_STALL_POLL_S=30s`; flags any slot alive ≥ `RED_AFK_STALL_THRESHOLD_S=600` whose agent lane has been idle ≥ the same — surfaces as `⏸️ stalled` in `/dev:afk monitor`. It keys off the agent lane, never `afk.log`/`log.jsonl`, because the orchestrator heartbeat writes those every minute and would mask a real stall — the masking that defeated detection in #243), the **hard stall reaper** (a slot silent on the agent lane past `RED_AFK_STALL_KILL_THRESHOLD_S=1800` is only a *candidate*: the irreversible kill is gated behind a reaper-signal predicate, so a worker mid-build/test — an active `vitest`/`tsc`/`cargo`/… descendant under its tree, or non-trivial aggregate cpu — is **busy** and left alone, while a genuinely stuck worker [idle past the threshold, no active descendant, flat cpu] is killed tree-wide, a `data-attempt-status="no-sentinel"` envelope is posted with the attempt-dir `afk.log` tail, the issue label is rotated back to `ready-for-agent`, the worktree + attempt dir are removed, and the slot is freed for the next health-check respawn — `RED_AFK_STALL_KILL_THRESHOLD_S` must be strictly greater than `RED_AFK_STALL_THRESHOLD_S`, validated at supervisor boot), and per-slot build isolation.

**Worker env passthrough.** Any `RED_AFK_*` variable exported in the operator's shell before `/dev:afk fleet` is auto-forwarded to every worker the supervisor spawns. Use this for worker-side toggles like `RED_AFK_SKIP_PERF=1` or `RED_AFK_SKIP_COMPETITIVE_BASELINE=1` without writing a hook. Internal supervisor knobs (`RED_AFK_TARGET`, `RED_AFK_POLL_S`, `RED_AFK_STALL_*`, `RED_AFK_CIRCUIT_*`, `RED_AFK_RUNNER`, `RED_AFK_REQUEST`, `RED_AFK_PLUGIN_DIR`) and the per-slot `*_BASE` build-isolation vars are excluded — they have dedicated wiring and the supervisor denylists them from passthrough. The supervisor re-pins `RED_AFK_RUNNER=<runner>` for each worker.

```bash
$ export RED_AFK_SKIP_PERF=1
$ export RED_AFK_SKIP_COMPETITIVE_BASELINE=1
$ /dev:afk fleet 1   # every worker sees both vars
```

Fleet mode is **runner-portable**: the supervisor is plain process orchestration, not a Claude Code primitive. Claude Code, Codex, and bare terminals may all launch and stop the supervisor when the normal AFK hard preconditions pass. Runner-specific observability degrades independently:

- Claude Code: schedule the auto-monitor cron when `CronCreate`/`CronList` are available; if not, launch fleet anyway and print `monitor loop unavailable in this runner; run /dev:afk monitor or tail .red/tmp/afk-supervisor.log manually.`
- Codex: launch fleet with `RED_AFK_RUNNER=codex`, skip cron, and spawn one read-only Codex monitor agent from the bundle's `codex-monitor-agent --mode fleet` prompt when a sub-agent primitive is available. If no sub-agent primitive is available, launch fleet anyway and print the same manual-monitor guidance.
- Bare terminal / unknown runner: launch fleet, skip cron/native monitor, and print the manual-monitor guidance.

### `/dev:afk fleet [N]` — launch

`N` is optional and defaults to `2`. Parse it as a non-negative integer; reject anything else (including `stop`, which is the other subcommand and routes below). Steps the agent must perform, in order:

1. **Resolve runner.** Determine the active runner using the same intent as the normal AFK cascade: explicit user `--runner` if present, else `RED_AFK_RUNNER`, else runner env/process/path signals, else `claude`. The resolved value is carried into the supervisor as `RED_AFK_RUNNER=<runner>` so detached workers do not fall through to the supervisor's historical `claude` fallback. Under Codex, this must resolve to `codex`.
2. **PID-file pre-check.** Read `.red/tmp/afk-supervisor.pid`. If it exists and `kill -0 <pid>` succeeds, refuse the launch:
   ```
   ✗ fleet already running (supervisor pid=<pid>, log .red/tmp/afk-supervisor.log).
     to stop it: /dev:afk fleet stop
   ```
   Do **not** touch the file or attempt to recover. A stale PID file (file exists but `kill -0` fails) is left alone — the `fleet` command clears it itself when it acquires the supervisor lock.
3. **Launch the fleet.** From the project root, run the bundle's `fleet` command with the target and any flags:
   ```bash
   RED_AFK_RUNNER=<runner> node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" fleet <N> [--request <text>]
   ```
   The command performs the PID-file pre-check from step 2 itself (refusing if a live supervisor already runs), detaches the supervisor, and forwards the resolved runner and the `--request/-r` text to every worker it spawns. It waits up to 3 s for `.red/tmp/afk-supervisor.pid` to appear and contain a live PID, then prints the launched supervisor PID and target; on failure it reports the tail of `.red/tmp/afk-supervisor.log`. Capture the reported PID for the *Report back* step. The launched supervisor is the native `__supervise` entrypoint of the same bundle.
4. **Attach the best available monitor surface.**
   - Claude Code: same flow as *Auto-Monitor Loop* — `CronList` first to deduplicate, then `CronCreate(cron="*/10 * * * *", prompt="/dev:afk monitor", recurring=true)`. If cron tools are unavailable, skip and use the manual-monitor line.
   - Codex: fetch a sub-agent spawn primitive via `ToolSearch` (query: `spawn agent background monitor`). If available, emit the canonical prompt with `RED_AFK_RUNNER=codex node "$CODEX_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" codex-monitor-agent --project-root "$PWD" --mode fleet` and spawn exactly one read-only Codex monitor agent for this newly-launched supervisor. Its task: from the project root, periodically run `/dev:afk monitor --once` (the bundle's `monitor --once`), report concise progress, and auto-close when `.red/tmp/afk-supervisor.pid` is missing/dead and no `[live]` workers remain. It must never edit files, claim issues, stop workers, or run merges. The user may close it manually; workers continue. If the primitive is unavailable, skip and use the manual-monitor line.
   - Bare/unknown: skip native monitor setup and use the manual-monitor line.
5. **Report back.** Print:
   ```
   🚀 fleet launched (supervisor pid=<pid>, target=<N>)
      log:   .red/tmp/afk-supervisor.log
      stop:  /dev:afk fleet stop
      <monitor-status-line>
   ```
   Monitor status line choices:
   - Claude cron scheduled: `monitor loop scheduled (every 10 min) — auto-cancels when all workers exit.`
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

1. **Sweep affected attempt dirs.** From the slot log (`afk-supervisor-slot-{slot}.log`) the supervisor parses every `[afk] worker: w…` boot stamp emitted while the slot was alive, globs `.red/tmp/workers/{wid}/*/` for each ID, and reads `afk.state.json`'s `.current.number` to identify the affected issues. Each attempt dir is `rm -rf`'d after its issue has been processed.
2. **Post a discard envelope on each affected issue.** Same `<details data-attempt-status="…">` schema as the per-issue terminal envelope, with `status="discarded"` and a summary line that names the runner and the trip cause (`runner-broken, slot parked after K fast deaths`). The envelope's `data-section="summary"` block carries the slot index, comma-joined worker IDs, fast-death count, and the supervisor log path. No `notes`, `drop`, or `log` sections — the attempts produced no usable artefacts.
3. **Restore label state on each affected issue.** Single `gh issue edit` adds `ready-for-agent` and `runner-error`, removes `ready-for-human` and (defensively) `running` — covers both the "issue had already been promoted to `ready-for-human`" path and the "issue was still `running` at the moment of trip" path.

The `runner-error` label is created idempotently by `/setup-red-skills` (see [triage-labels.md](../setup-red-skills/triage-labels.md)). The supervisor still calls `gh label create runner-error` on the fly during a trip so cleanup never fails just because the label is missing.

Idempotency: `SLOT_SWEPT[slot]=1` blocks a second sweep within the same supervisor lifetime. Across restarts a new trip yields fresh worker IDs and fresh attempt dirs, so re-tripping never re-touches the previously swept issues. A trip that finds no claimed issues (all workers exited before claiming) parks the slot but posts no envelopes — the attempt-dir sweep is a no-op.

### Refs

- The bundle's `fleet` / `fleet stop` commands — the entrypoints this section drives. Stop-file path, env contract, circuit breaker, and trip-sweep are part of the supervisor behaviour described above.
- *Auto-Monitor Loop* above — the cron lifecycle Fleet Mode hooks into.
- *Self-Cancel* under Monitor — the dual teardown path (cron tears itself down when no workers remain; fleet stop tears it down immediately).

## Monitor

> **BINDING — every monitor tick must do BOTH of the following, in order. No shortcuts.**
>
> 1. **Render the dashboard** (the bundle's `monitor --once`).
> 2. **Mirror live workers onto the host runner's native task surface.** Per-runner mapping:
>    - **Claude Code:** pipe the tracked-task JSONL into the bundle's `monitor --mirror-plan` and apply the emitted call plan via `TaskCreate` (one task per live worker, titled `#<n> w<id> — <title>`) and `TaskUpdate` (description carries `stage:<x>`, terminal events flip `state` to `completed`/`failed`). See *Task Mirror* below for the full protocol.
>    - **Codex:** run `monitor --mirror-plan --runner codex`. Today Codex exposes no native task surface, so the sink emits an empty plan and the mirror falls back to the dashboard plus a one-line notice — that *is* the mirror under Codex; do not silently skip. If Codex grows a native surface, the sink emits the same call-plan descriptors against it.
>    - **Bare terminal / unknown runner:** skip the mirror silently — the `monitor` dashboard is the canonical view.
>
> The mirror is the only way the user sees per-worker progress advance in their native UI. Skipping it (because "nothing changed" or "just answering a status question") is a bug, not a shortcut — `monitor --mirror-plan` is idempotent and emits zero descriptors when nothing changed.

`/afk monitor` is the readonly aggregated view across all live workers. **Run the bundle's `monitor` command — do not reinvent the rendering in inline bash.** It:

1. Globs `.red/tmp/workers/*/*/afk.state.json` and renders one section per active attempt.
2. Verifies liveness via the orchestrator PID recorded in `afk.state.json` (`.pid` field) — attempts whose PID is dead are flagged `stale`/`gone` and excluded, not counted as running.
3. Optionally tails the sibling `afk.log` for the most recent line under each worker's header.
4. Renders the 48h sparkline header (next subsection) on every refresh.

To invoke, from the project root:

```bash
RED_AFK_RUNNER=<runner> node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" monitor
```

The command has **two modes**, auto-selected by stdout type:

- **TTY (real terminal)**: full box-drawing layout, refreshes every 3 s, `clear` between frames. Ctrl-C to exit.
- **Non-TTY (piped, captured by an agent, redirected)**: one-shot **compact dashboard** — one sparkline header + one line per worker, then exit 0. Force this with `--once` or `RED_AFK_MONITOR_COMPACT=1` even from a TTY.

Compact output shape (≈3 lines total for 2 workers — fits inline without truncation in an agent transcript):

```
48h: ···············································█  (4 closed, peak 4/h, all workers)   Δ fleet +382 -45
wZ2R4 [live] claude  issues 4/5  #150 [blog/D] Agent SDK on RedDB  stage:impl  00:23:01  +382 -45
wK7M2 [live] codex   issues 0/16  idle  +0 -0
```

The progress counter is `issues <done>/<total>` — issues *closed* over the queue total, **not** a completion percentage (the old `(80%)` form read as "no work done" while a worker had already committed thousands of lines). The real volume signal is the `+A -R` **diff** (committed + uncommitted, measured from the branch's merge-base with `origin/main`), which is rendered on **every** worker line unconditionally — idle and `+0 -0` included — and **summed across the fleet** into the `Δ fleet +A -R` suffix on the sparkline header, so the total diff volume is always visible at a glance.

When invoking from inside another agent session (Claude Code, Codex), prefer `--once` even if stdin is a pipe — explicit beats inference. Don't use the full TTY mode in agent transcripts; the 3 s refresh loop floods the captured stream and gets truncated to garbage.

Single-worker operation shows one section/line. Multi-worker adds one section/line per live worker, sorted by `started_at`. The sparkline aggregates **all workers** in this checkout's `.red/state/afk-history.jsonl` — not fractured per-worker; the `Δ fleet` diff total likewise sums every worker.

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

`.red/state/` is gitignored. The orchestrator creates it during bootstrap, parallel workers serialise appends via `flock`, and the boot-time orphan sweep truncates the file to the last 10000 lines if it grows past that cap.

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
3. If `live_workers >= 1` or `.red/tmp/afk-supervisor.pid` resolves to a live PID: arm the cron when unwatched (observe path — same dedup as the spawn path):
   - Fetch `CronCreate` and `CronList` via `ToolSearch` if not already loaded (deferred tools).
   - `CronList` — if any existing job has `prompt == "/dev:afk monitor"`, **skip** (cron already present; it continues firing every 10 minutes).
   - Otherwise `CronCreate(cron="*/10 * * * *", prompt="/dev:afk monitor", recurring=true)` and tell the user one line: `monitor loop scheduled (every 10 min) — auto-cancels when all workers exit.`
   - If `CronCreate` is unavailable (non-Claude-Code host), skip silently.

When `CronList` / `CronDelete` are unavailable (Codex runner, or `/afk monitor` invoked outside Claude Code), skip the teardown silently — the cron infrastructure isn't running there to begin with.

### Task Mirror And Codex Monitor Agent (binding)

Every `/dev:afk monitor` run also **mirrors each live worker onto the runner's native task list when that runner exposes one**, so a `/afk` session surfaces progress on the host's native UI — advancing through stages on its own, with no extra typing. This is a **read-only reflection of `afk.state.json`**; the mirror never writes state and never touches the orchestration.

**Host capability matrix (binding — no parity).** The Task mirror is per-runner by construction (ADR 0003/0015): there is **no shared native task API** across the hosts, so each runner gets its own explicit adapter, never a generic cross-runner abstraction. The honest matrix — encoded as `taskMirrorCapability(host)` in `core/mirror.ts` and exercised by `tests/mirror.test.ts` — is:

| Host (Agent runner) | Surface | Native task API | Adapter / sink | Today's behavior |
|---|---|---|---|---|
| Claude Code | `native-task` | yes | `mirrorPlan` (`TaskCreate`/`TaskUpdate`) | the in-session Agent runner drives the native Task mirror through the host task tools |
| Codex | `monitor-agent` | no | `codexSinkPlan` | no task API — the mirror falls back to the `monitor` dashboard plus **one read-only Codex monitor agent** |
| OpenCode runner | `headless` | no | none (empty plan) | a headless API-auth **Worker** with no host session — there is no surface to mirror into, so no native calls are ever emitted |

The three surfaces are deliberately distinct values (never a single `supported: boolean`) so the matrix can **never imply parity**. Exactly one host (Claude Code) exposes a native task API; the other two degrade explicitly, each on its own adapter. An unknown host fails loudly rather than silently inheriting the Claude native path.

The mirror surfaces **two signals on one lifecycle** (issue #811): the task **title** carries the calm **macro phase** — `w<id> [<n>/5 <phase>] #<issue> <slug>` — while the task **description** carries the fine **micro stage** — `stage: <impl|explore|tests|commit>`. The phase vocabulary is the ordered `setup → coding → validating → merging → done` (1-based `n/5`), plus the terminal `blocked` which drops the `n/5` and renders `[blocked]`. The title changes only when the macro phase moves, so it never flickers on every inner-agent tool call.

The mirror is a pure diff: it reconciles the live worker state files against the tasks already on the native surface and emits a **call plan**. After rendering the dashboard, the agent (under Claude Code only) must:

1. Fetch `TaskCreate`, `TaskUpdate`, and `TaskList` via `ToolSearch` if not already loaded (deferred tools).
2. **Build the tracked set.** `TaskList` → keep the mirror-owned tasks (those whose title matches `w<id> [<…>] #<n> <slug>`). For each, emit one JSONL line `{"key":"<worker_id>:<issue>","stage":"<last stage>","phase":"<last phase>"}`, reading the key (`worker_id` from the leading token, `issue` from the `#<n>`) and the **phase** (the word inside the title's `[…]` bracket, after any `n/5 `) from the title, and the **stage** from the description (`stage: <x>`). Keep a key→task_id map for step 4.
3. **Compute the plan.** Pipe the tracked JSONL from step 2 into the bundle's `monitor --mirror-plan` subcommand:
   ```bash
   printf '%s\n' "$tracked" | node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" monitor --mirror-plan
   ```
   The command globs the state files and reconciles them against the tracked set on stdin (keyed by `worker_id:issue`, so parallel workers each get exactly one task and re-runs never duplicate), then prints a JSONL **call plan** to stdout — one descriptor per harness call (empty stdin → cold reconcile; empty plan → no output). A `TaskUpdate` rewrites the **title** when the macro phase moves and refreshes the **description** when the micro stage moves; a terminal failure re-titles to `[blocked]` and flips the task to `failed`:
   ```jsonl
   {"call":"TaskCreate","key":"wAAAA:22","title":"wAAAA [2/5 coding] #22 extract state.sh","description":"stage: impl","state":"in_progress"}
   {"call":"TaskUpdate","key":"wAAAA:22","title":"wAAAA [3/5 validating] #22 extract state.sh","description":"stage: tests","state":"in_progress"}
   {"call":"TaskUpdate","key":"wAAAA:22","state":"completed"}
   ```
4. **Apply the plan.** For each descriptor in order:
   - `TaskCreate` → create the task; record `key → task_id`.
   - `TaskUpdate` → resolve `key` to its `task_id` via the map and update. A `state` of `completed`/`failed` marks the worker's terminal event (`done`/`blocked`); the task drops off the active list and the mirror self-cleans. A descriptor whose `key` has no known `task_id` (e.g. a complete for a task that was never created in this session) is skipped.

An empty plan means nothing changed since the last tick — apply no calls. Because the plan is keyed by `worker_id:issue`, an idempotent re-run with no stage advance emits zero descriptors.

**Re-hydration on session reopen.** A native task dies with the Claude Code session; the `nohup` AFK worker does not. When a session opens with workers still running, `TaskList` (step 2) returns no mirror-owned tasks, so the tracked set is **empty** and `monitor --mirror-plan` reconciles cold — emitting a `TaskCreate` for every live worker. The status bar recovers the per-worker tasks with no operator action. This is the same path as steady-state, not a new one: only workers whose orchestrator PID (the `.pid` field in `afk.state.json`, via `state_is_live`) is alive re-hydrate (dead workers are untracked-terminal on a cold tick → no ghost task), and the next tick is idempotent because the freshly-created tasks now form the tracked set.

When `TaskCreate` / `TaskUpdate` are unavailable because the session is **outside any runner** (a bare terminal), **skip the mirror silently** — there is no native surface to drive, and the `monitor` dashboard is already the canonical view.

**Codex sink (runner-specific — binding).** The mirror is per-runner, mirroring the `runner-claude.md` / `runner-codex.md` split (ADR 0003). Under Codex the state reader and plan reconciler are reused unchanged — only the sink differs. After rendering the dashboard, the Codex agent runs `monitor --mirror-plan --runner codex` instead of the Claude `TaskCreate`/`TaskUpdate` loop:

- If Codex grows a native background-task surface, the sink emits the **same call-plan descriptors** the Claude sink applies — apply them against the Codex primitive.
- Otherwise (today's reality), `--runner codex` emits an **empty plan**, so the mirror falls back to the `monitor` dashboard and a one-line notice. No native calls are emitted, so there is no half-rendered state, and a dashboard hiccup is swallowed so the tick never crashes.

**Codex monitor agent (Codex-only — binding).** Codex has a native sub-agent UI even though it does not expose the Claude-style `TaskCreate`/`TaskUpdate` task API. When `/dev:afk run` launches a normal detached worker under Codex, or `/dev:afk fleet N` launches a new supervisor under Codex, the agent should spawn exactly one read-only Codex monitor agent when the sub-agent primitive is available. Generate its prompt with `codex-monitor-agent --mode run|fleet` so the read-only rules stay identical across single-worker and fleet launches. That monitor agent periodically runs `/dev:afk monitor --once`, reports concise progress, and exits once no supervisor or live workers remain. It is a presentation consumer only: it must not edit files, stop workers, claim issues, run validation, push, merge, or repair state. Closing it manually must not affect the worker or fleet.

Do **not** invent a cross-runner task abstraction (rejected in ADR 0003) — keep the adapter explicitly per-runner.

## Handoff file template

The inner agent reads `../handoff.md` — top-level XML wrappers (`<issue-body>`, `<previous-attempts>`, `<prior-attempt-context>`, `<human-guidance-thread>`, `<thread-discussion>`, `<agent-notes>`) keep body/comments/notes unambiguous. Full template: [`docs/HANDOFF.md`](./docs/HANDOFF.md).

## Stop Conditions

- Queue drained → `<promise>NO MORE TASKS</promise>` → exit 0.
- `-n N` reached → summary + exit 0.
- Runner exhaustion / runner transport failure → route the current issue through bounded recovery (`blocked:quota` or `blocked:runner-transient`), then stop the outer run with exit 75.
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

## Configuration & lifecycle hooks

All `.red/config.yaml` knobs + `RED_AFK_*` env overrides (sandbox, runner, model/effort, timeouts, retry caps, stall thresholds, backpressure) and the lifecycle-hook contract live in [`docs/CONFIG.md`](./docs/CONFIG.md). The runtime supplies the documented base env (`RED_AFK_REPO`, `RED_AFK_ROOT`, `RED_AFK_WORKSPACE`, `RED_AFK_RUNNER`, optional `RED_AFK_SLOT`) and layers each hook event's documented `RED_AFK_*` variables from that event's JSON context. Runner/model resolution policy: [`../model-tier-policy/SKILL.md`](../model-tier-policy/SKILL.md).

## Safety

See [`SAFETY.md`](SAFETY.md). The orchestrator and the inner agent both inherit those rules. Violations abort the loop.

## Source Of Truth

This skill is the single source of truth for autonomous execution in red-skills repos.
