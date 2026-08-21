---
name: afk
working-mode: spec-driven
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Registers the project with the `redskilled` daemon at a runner and a target width, arms the drain, and observes; the daemon admits each Worker, which claims an issue, works it in its own workspace, validates, lands, and closes. Use when the user wants to run AFK execution, drain a Spec, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--spec N | --issues N,N,N] [--tags a,b] [--user login|@me] [--runner claude|codex|opencode] [--request TEXT] [-n N] | stop [--force] | status | logs --supervisor|--worker ID|--all | monitor | dashboard | daily-review | weekly-review | retake N | reap"
---

# /afk

**The default lane for all tracked backlog work.** `/afk` is the modus
operandi; `/go` is the ad-hoc-only exception.

**`/afk` is thin: register, drain, observe.** It is the spec-driven Working mode's
entrance (ADR 0150 §1) — the last step of `/start` → `/to-spec` → `/to-tickets` →
`/afk`. The skill registers this project with the always-on `redskilled` daemon at
a runner and a target width, arms the drain, and then watches. **Everything after
"arm" belongs to the daemon**: it admits each Worker against the host budget,
places its workspace, and the Worker claims the Ticket, works it, validates it,
publishes it and closes it (ADR 0148, ADR 0149). `/afk` starts no process of its
own, reads no state out of the human's checkout, and composes no Worker argv.

<what-to-do>

## The three steps

**Every capability below is an `rs_dev` MCP tool returning structured TOON.** The
complete tool surface, the host tool-name prefix rule, and the mutation-mode
contract live in [`MCP.md`](./MCP.md) — read it before the first call and do not
restate the tool list here.

**Four verbs answer today: `drain`, `status`, `project_status`, `project_stop`
(#4113).** Every other tool refuses by name, because its engine went with
ADR 0147 and no daemon method serves it yet. **A refusal is not an outage and no
reload cures it** — it means the verb is unimplemented, so file against #4113
rather than hunting the daemon, the socket, capacity or a version skew. Read
[`MCP.md`](./MCP.md#which-tools-answer-today-4113) for which row is which.

**1. Register.** `drain` (mutating) ensures the daemon is reachable and this
project is registered at the requested runner and target. It composes the
registration from `.red/config.yaml` itself, so a no-argument `drain` is the
whole live entrance. `drain` is ensure-style: repeated calls succeed and report
the four-dimension difference, and a runner change is refused with the explicit
stop-then-drain repair. `project_activation`, `project_start`, `project_resize`
and `project_reset` are the specialized lifecycle operations around it and all
refuse today.

**2. Arm the selector.** The selector scopes what the drain takes —
`{spec, lane, label, issues, tags, user}`. It travels in the registration, so one
producer applies several selectors as an ordered priority rather than several
competing loops. `queue_status` is the intended scoped preview and refuses today
(#4113), so arm the selector on `drain` itself.

**3. Observe.** `status {scope: worker | project | host}` reads progress at the
needed boundary — it is the one live observation verb. `events_since`, `logs` and
`deadend_audit` all refuse today (#4113), so `status` and `project_status` carry
the whole watch until slice 2 serves them. **Never poll a mutating tool for
status.**

**When the MCP is unreachable, ask whether the plugin was installed or updated in
THIS session — if so, run `/reload-plugins` (or start a new session).** MCP servers
register at plugin load, so a mid-session install writes the declaration and starts
no process: `.mcp.json`, the manifests and the launchers are all valid on disk while
the session sees zero tools. That is a load-lifecycle gap, not an outage.

**Once the reload is ruled out, the repair is the daemon — there is nothing to
fall back to.** ADR 0147 rule 1 deleted the second implementation rather than
deprecating it, so an unreachable tool surface means the daemon is down or this
project is not registered. Name that, and repair it with `/redskilled`. Do not
hand-roll the operation in shell.

## The calls, in order

The whole live lane is three tools; anything done by hand instead of these is a
defect to file, never a workaround to keep:

1. `drain { target, runner?, selector? }` — mutate: registers this project with
   the daemon (work query, poll plan, trunk, Worker prompt all composed by the
   tool) and arms the drain. Repeat calls are safe and report what was kept.
2. `status { scope: project }` — observe. Workers are born, briefed, and driven
   by the daemon; nothing here polls a mutating tool. `events_since` is the
   intended incremental read and refuses today (#4113).
3. `project_stop` — hand the registration back when done.

**Never** `git worktree add`, never a hand-built Worker argv, never watching CI
in a shell loop: the daemon owns birth, placement, and landing. If a step
cannot be done through these tools, that is a gap to file against the MCP.

## When To Use

Each verb names the tool that serves it.

- `/afk` — drain every open issue labelled `ready-for-agent`. `drain` registers
  and arms; `queue_status`, the census that would precede it, refuses today
  (#4113).
- `/afk --spec 42` — drain only Tickets linked to Spec #42; the Spec itself is
  excluded. This is the `selector.spec` facet.
- `/afk --issues 356,359,362` — drain an explicit issue list in that order
  (`selector.issues`). For exactly one tracked Ticket, `worker_dispatch` with
  `issue` runs it without registering a drain at all.
- `/afk --tags backend,infra` — drain only issues carrying EVERY requested
  `tag:<value>` territory label (AND semantics; an untagged issue is outside every
  tag-scoped selector). Combines with `--spec`, never with `--issues`. An
  unfiltered `/afk` still drains everything — tags partition the pool, they never
  bind issues to users.
- `/afk --user filipeforattini` or `/afk --user @me` — drain only issues AUTHORED
  by that GitHub login (`@me` resolves at registration). Author, not assignee:
  creating an issue is enough.
- `/afk --runner codex` — pin a backend. `runner_list` and `runner_detect` answer
  which backends exist and which one this host resolves to.
- `/afk --request "..."` or `/afk -r "..."` — a special request block for the
  inner agent. `worker_request` carries it at spawn time; `runner_steer` reaches a
  Worker already running.
- `/afk -n 5` — cap the run at five Tickets; `-n 0` and omitted `-n` mean an
  unlimited queue drain.
- `/afk status` — `status {scope: project}`: registration, target width, slot
  occupancy, runner, live Workers, and the daemon's own verdict. Answers "what is
  actually running?" without cross-referencing pid files by hand.
- `/afk stop [--force]` — `project_stop`: hand this project's registration back
  while in-flight Workers drain; `--force` hard-stops only its attributed Workers.
- `/afk logs --supervisor|--worker <id>|--all` — the `logs` tool, one lane per
  call, read-only.
- `/afk monitor` — read-only status board over `status {scope: worker}` and
  `queue_status`; read [`monitor.md`](./monitor.md) for the board and the
  native-task mirror contract.
- `/afk dashboard [--period 30d]` — `dashboard`: open work, live Workers, flow
  metrics and DORA proxies over a `periodDays` window.
- `/afk daily-review` / `/afk weekly-review` — `daily_review` / `weekly_review`
  over the same activity core.
- `/afk retake 123` — `retake`, a read tool that only recommends; the action it
  names is a separate explicit call.
- `/afk reap` — `reap`: branch hygiene. `unblock_sweep` is its dependency-gate
  counterpart.

Read [`fleet.md`](./fleet.md) before changing the width of a running drain.
For GitHub Actions adoption, use [`actions-lane.md`](./actions-lane.md).

## Operating Contract

Read the focused reference before touching that concern:

- The `rs_dev` MCP tool surface, host prefixing and mutation modes:
  [`MCP.md`](./MCP.md).
- Issue selection, lifecycle, failure labels, the per-issue loop, merge/close,
  runner fallback, completion bounds, stop conditions and reporting:
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).
- What happens to live state when the daemon takes over birth:
  [`docs/CUTOVER.md`](./docs/CUTOVER.md).
- Durable engine state lives under `.red/state/castle/`; disposable Worker
  workspaces, claim locks, logs and diagnostics stay in registered `.red/tmp/`
  lanes and are the only targets of the lane janitor.
- State files, terminal-event envelope, worker-outcome mapping, TOONL lanes and
  failure snapshots: [`docs/ENVELOPE.md`](./docs/ENVELOPE.md).
- Handoff wrappers and inner-agent prompt materialisation:
  [`docs/HANDOFF.md`](./docs/HANDOFF.md) and [`AGENT-PROMPT.md`](./AGENT-PROMPT.md).
- Runner-specific behavior: [`runner-claude.md`](./runner-claude.md),
  [`runner-codex.md`](./runner-codex.md), [`runner-opencode.md`](./runner-opencode.md),
  and fallback [`runner-hermes.md`](./runner-hermes.md).
- What makes each Agent able to work with nobody at the keyboard, and the
  evidence behind each answer:
  [`runner-unattended-posture.md`](./runner-unattended-posture.md).
- Liveness, stall protection and lane-idle rules:
  [`docs/LIVENESS.md`](./docs/LIVENESS.md).
- Config, env overrides, lifecycle hooks, sandbox/runner/model settings, the
  declared Validation moments and their concurrency ceiling:
  [`docs/CONFIG.md`](./docs/CONFIG.md).
- Safety rules for shell and git actions: [`SAFETY.md`](SAFETY.md).

## Load-Bearing Rules

- **The `rs_dev` MCP is the canonical project interface** (ADR 0120, naming
  amended by ADR 0142, sole surface by ADR 0147). `/afk` is a client of it, so a
  capability missing from the tools is a gap to file against the MCP, never a
  reason to hand-roll the operation in shell.
- **An unserved verb refuses by name, and the refusal is the truth** (#4113).
  Only `drain`, `status`, `project_status` and `project_stop` reach the daemon;
  the rest state that no `_redskills/*` method serves them. Report the refusal
  and move on — do not retry it, do not restart the daemon for it, and do not
  substitute a shell equivalent.
- **The daemon is always on and nothing else births a Worker.** `/red-setup` (or
  `/redskilled`) installs it as an OS service with no idle exit. A client that
  finds no daemon fails closed with the repair hint; it never spawns one
  (ADR 0150 §4).
- **Tracked work belongs in `/afk`.** A queue with zero eligible
  `ready-for-agent` entries and a non-empty open backlog is a flow bug to surface
  with a gate census, not a clean "nothing to do" stop. That includes a queue whose
  entries are all `held_for_summon`; release those with `triage:summon`, the
  `triage` tool's `summon`, or `afk.trust-gate.allowlist`.
- Dependencies use `req:N` edge labels plus `blocked:dependency`; human gates use
  `## Current blocker` / `ready-for-human`.
- Worker workspaces live under `.red/tmp/workers/{id}/{issue}` with the worktree at
  `.red/tmp/workers/{id}/{issue}/worktree`; everything the Worker narrates is TOONL
  in `.red/tmp/workers/{id}/worker.log.toonl`.
- Claiming uses the three-layer scheme: local lock, GitHub label pre-check, and a
  stale-lock sweep the daemon owns. Inspect it with `claim_status`; cure a ghost
  claim with `claim_release`, never by editing labels by hand.
- The inner agent's canonical completion signals are `<promise>DONE</promise>` and
  `<promise>BLOCKED</promise>`.
- `plugins.dev.afk.validation` is the sole local validation authority. Its ordered
  `iteration`, `post_done` and `landing` command lists are run only at those named
  moments; an undeclared moment is skipped loudly and `[]` is an explicit empty
  declaration. The engine never discovers or improvises a suite.
- `iteration` is handed to the inner agent while it writes. `post_done` runs at the
  branch's fork point after DONE, and a correction re-runs only its failed subset
  before folding back to the full declaration. `landing` runs before push/PR/queue.
  The merge queue is the CI-side final Validation moment and owns freshness against
  the merged result.
- The **Queue Custodian** owns an unlocked PR after Landing arms native merge intent
  and records the custody hand-off. Landing then ends: the Worker does not poll the
  merge, classify an ejection, or close the Ticket.
- The **Verdict** is the one pure failed-Validation decision. Checks, history and
  environment facts enter; fault, budget effect and park-now leave. Concrete
  compiler, assertion and guard evidence is branch fault at any duration; only an
  evidence-free sub-second failure may be suspect infrastructure.
- The **Park** has one door. `blocker-state` alone parses, writes and clears the
  active blocker, and every return to `ready-for-agent` calls `applyRequeue` with
  `machine` or `human` authority.
- **The gate command is canonical.** Workers run the exact commands handed to them
  and never self-impose stricter flags, extra lint restrictions, widened target
  sets, or a harder contract. An error that appears only under an extra check is
  reconciled against the declared schedule before any red `main` is reported.
- `blocked:ci` leaves the completed PR open and escalates to `ready-for-human`; AFK
  does not re-run the inner agent for already-complete work waiting on CI.

## Parallelization

**Width is a registered number, not a number of terminals.** One project has one
producer: `drain` registers the target width, `project_resize` changes it, and the
daemon admits Workers against the host budget up to that target. Choose the width
by disjointness of the selector; read [`fleet.md`](./fleet.md) for the full rule.

## Stop Conditions

- Eligible queue drained → the drain reports it, with a gate census when open
  non-Spec issues remain, including ready-labelled issues held for maintainer
  summon.
- `-n N` reached → summary.
- Runner exhaustion → bounded recovery for the current Ticket, then the Worker's
  own exit; the producer keeps its registration.
- The daemon unreachable → fail closed with the repair hint. `/afk` never
  substitutes itself for the daemon.

## Safety

See [`SAFETY.md`](SAFETY.md). The Worker and inner agent both inherit those rules;
violations abort the run.

</what-to-do>

<supporting-info>

For failure-state playbooks and operator recovery procedures, see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

</supporting-info>
