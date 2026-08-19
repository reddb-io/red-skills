---
name: afk
working-mode: spec-driven
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a Spec, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--spec N | --issues N,N,N] [--tags a,b] [--user login|@me] [--runner claude|codex|opencode] [--alternate] [--fallback-runner] [--request TEXT] [-n N] [--once] [--boot-only] | fleet [N] | fleet stop [--force] | fleet status | fleet logs --supervisor|--worker ID|--all [--follow] | monitor | dashboard | daily-review | weekly-review | retake N | reap"
---

# /afk

**The default lane for all tracked backlog work.** `/afk` is the modus
operandi; `/go` is the ad-hoc-only exception. Drain the agent-ready backlog by
letting the runtime select issues, create isolated worktrees, run the inner
agent, validate, land, close, and clean up.

## Operate project execution through the `redskilled` MCP

**The `redskilled` MCP is the interface; `/afk` is one of its clients.** Every
execution capability this skill needs — queue, dispatch, runners, gate,
landing, claim, worktrees, hygiene, observability — is an MCP tool returning
structured TOON. Drive those tools; do not shell out to reimplement what a tool
already does. The complete tool surface, the host tool-name prefix rule, and the
mutation-mode contract live in [`MCP.md`](./MCP.md) — read it before the first
call and do not restate the tool list here.

The usual shape of a drain:

1. `queue_status` — what is drainable now, before anything is claimed.
2. `runner_detect` — confirm the runner this host resolves to.
3. `worker_dispatch` (one issue) or `project_start` (this project's workers) to start work.
4. `status {scope: worker | project | host}` — read progress at the needed
   boundary; never poll a mutating tool for status.
5. `gate_run` → `land_branch` when a worker branch needs validation and landing
   outside the normal in-worker path.

**When the MCP is unreachable, first ask whether the plugin was installed or
updated in THIS session — if so, run `/reload-plugins` (or start a new session)
before falling back.** MCP servers register at plugin load, so a mid-session
install writes the declaration and starts no process: `.mcp.json`, the manifests
and the launchers are all valid on disk while the session sees zero tools. That
is a load-lifecycle gap, not an outage, and the CLI fallback would hide it.

**Only once the reload is ruled out: name the unreachability and fall back to
the `red-skills-dev` CLI** — the same engine over the same cores, so the
fallback changes transport,
not behavior. The invoking LLM is responsible for setting `RED_AFK_RUNNER` to
its own host runner (`codex` from Codex, `claude` from Claude Code). Resolve the
runtime through the shared contract in
[`../_report-runtime/WRAPPER.md`](../_report-runtime/WRAPPER.md): the canonical
form is the ADR 0091 npm direct-run
`npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev ...`, which works on
every installation; an installed `red-skills-dev` shim on `PATH` is only a
warm-cache optimization for the same command.

Run the bundle, not the source:

```bash
RED_AFK_RUNNER=<claude|codex|opencode> npx -y -p @reddb-io/red-skills-dev@<version> red-skills-dev <command> [params]
```

`afk.mjs` is a dedicated forwarder to the `dev` bundle. Every argument reaches
the orchestrator unchanged. The AFK queue-drain subcommand is `run`; valid
top-level dev CLI subcommands include `run`, `monitor`, `fleet`, `dashboard`,
`daily-review`, `weekly-review`, `retake`, `requeue`, and `reap`. A bare
`--issues 42` is forwarded to the same run surface. There is no `afk`
subcommand on the dev CLI. Runtime details and the full operations
contract live in [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).

## When To Use

Each verb below names the `redskilled` tool that serves it; the flag form is the
CLI fallback for the same operation.

- `/afk` - drain every open issue labelled `ready-for-agent`. Read the queue
  with `queue_status`, then dispatch with `worker_dispatch` or `project_start`.
- `/afk --spec 42` - drain only tickets linked to Spec #42; the Spec issue
  itself is excluded. On the producer this is the `selector.spec` facet.
- `/afk --issues 356,359,362` - drain an explicit issue list in that order; on
  the producer, `selector.issues`.
- `/afk --tags backend,infra` - drain only issues carrying EVERY requested
  `tag:<value>` territory label (AND semantics; an untagged issue is outside
  every tag-scoped fleet). As a fleet this is `selector.tags`. Combines with
  `--spec`, never with `--issues`. An unfiltered `/afk` still drains
  everything — tags partition the pool, they never bind issues to users.
- `/afk --user filipeforattini` or `/afk --user @me` - drain only issues
  AUTHORED by that GitHub login (`@me` resolves to your own login at launch).
  As a fleet, `selector.user`. Author, not assignee: creating an issue is
  enough — no manual assignment step.
- `/afk --runner codex` - pin a backend. This disables detection cascade and is
  mutually exclusive with `--alternate`. `runner_list` and `runner_detect`
  answer which backends exist and which one this host resolves to.
- `/afk --alternate` - opt into round-robin runner rotation between issues.
- `/afk --fallback-runner` - opt into one mid-issue runner swap on
  `RUNNER_EXHAUSTED`; otherwise exhaustion uses bounded `blocked:quota`
  recovery and exits 75.
- `/afk --request "..."` or `/afk -r "..."` - add a special user request block
  to every inner-agent prompt in this run. For a single worker this is
  `worker_request` at spawn time, or `runner_steer` to reach a worker already
  running.
- `/afk -n 5` - cap the run at five issues; `-n 0` and omitted `-n` mean
  unlimited queue drain.
- `/afk --once` - single supervised iteration for debugging the prompt.
- `/afk --boot-only` - run boot sweeps and prechecks without claiming work.
- `/afk monitor` - read-only status board over `status {scope: worker}` and
  `queue_status`; read [`monitor.md`](./monitor.md) for the dashboard and
  native-task mirror contract.
- `/afk dashboard [--period 30d] [--json]` - process dashboard for open work,
  local workers, flow metrics, and DORA proxies (`dashboard`, `periodDays`).
- `/afk daily-review [--json]` / `/afk weekly-review [--json]` - operational
  review for the local daily or six-day window, over `history` + `dashboard`.
- `/afk retake 123 [--apply] [--json]` - issue resumption report (`retake`, a
  read tool that only recommends); safe local setup only with `--apply`.
- `/afk fleet [N]` - supervise `N` concurrent workers via `project_start`, or
  resize a running one via `project_resize`; read [`fleet.md`](./fleet.md) before
  launch or stop operations.
- `/afk fleet stop [--force]` - `project_stop`: gracefully stop this project's
  supervisor while in-flight workers drain; `--force` hard-stops only workers
  attributed to its lane.
- `/afk fleet status` - `status {scope: project}`: read-only ground truth — supervisor pid, health verdict,
  runner, slot occupancy, bundle version/skew, churn, live workers, and whether
  a watchdog respawn would fire. Answers "what is actually running?" without
  cross-referencing pid files and snapshots by hand.
- `/afk fleet logs --supervisor|--worker <id>|--all [--follow]` - the `logs`
  tool, one lane per call. Read-only local view over the structured `red-castle`
  lanes: supervisor logs render the supervisor lane; worker logs render a single
  worker lane; `--all` merges all worker lanes and prefixes every line with the
  worker id.
- `/afk reap` - `reap`: run branch hygiene without starting a worker.
  `unblock_sweep` is its dependency-gate counterpart.

For GitHub Actions adoption, use [`actions-lane.md`](./actions-lane.md). The
same `/afk --issues N --runner opencode --once` lane runs as reusable workflow,
composite action, or local bundle invocation.

## Operating Contract

Read the focused reference before touching that concern:

- The `redskilled` MCP tool surface, host prefixing, mutation modes, and the CLI
  fallback rule: [`MCP.md`](./MCP.md).
- Runtime, sandcastle substrate, CLI forwarding, bootstrap, hard preconditions,
  issue selection, lifecycle, failure labels, per-issue loop, merge/close,
  runner fallback, completion bounds, stop conditions, and reporting:
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).
- Boot cleanup, stale attempts, branch reapers, and unblock sweep mechanics:
  [`docs/BOOT-SWEEPS.md`](./docs/BOOT-SWEEPS.md).
- What happens to live state when the daemon takes over birth — Workers in
  flight, durable lanes, stale artifacts, the report, and the rollback path:
  [`docs/CUTOVER.md`](./docs/CUTOVER.md).
- Durable AFK process state lives under `.red/state/castle/`; disposable worker
  attempts, claim locks, worktrees, logs, and diagnostics stay in registered
  `.red/tmp/` lanes and are the only targets of the lane janitor.
- State files, terminal-event envelope, worker-outcome mapping, JSONL lanes,
  and failure snapshots: [`docs/ENVELOPE.md`](./docs/ENVELOPE.md).
- Handoff wrappers and inner-agent prompt materialisation:
  [`docs/HANDOFF.md`](./docs/HANDOFF.md) and
  [`AGENT-PROMPT.md`](./AGENT-PROMPT.md).
- Runner-specific behavior: [`runner-claude.md`](./runner-claude.md),
  [`runner-codex.md`](./runner-codex.md),
  [`runner-opencode.md`](./runner-opencode.md), and fallback
  [`runner-hermes.md`](./runner-hermes.md).
- Liveness, stall protection, and lane-idle rules:
  [`docs/LIVENESS.md`](./docs/LIVENESS.md).
- Config, env overrides, lifecycle hooks, sandbox/runner/model settings, the
  declared Validation moments, and their concurrency ceiling:
  [`docs/CONFIG.md`](./docs/CONFIG.md).
- Safety rules for shell and git actions: [`SAFETY.md`](SAFETY.md).

## Load-Bearing Rules

- The `redskilled` MCP is the canonical project interface (ADR 0120, naming
  amended by ADR 0142). `/afk` is a
  client of it, so a capability missing from the tools is a gap to file against
  the MCP, never a reason to hand-roll the operation in shell.
- Tracked work belongs in `/afk`. A queue with zero eligible `ready-for-agent`
  entries and a non-empty open backlog is a flow bug to surface with a gate
  census, not a clean "nothing to do" stop. This includes a non-empty queue
  whose entries are all `held_for_summon`; release those with `triage:summon`,
  `dev triage --summon`, or `afk.trust-gate.allowlist`.
- Dependencies use `req:N` edge labels plus `blocked:dependency`; human gates
  use `## Current blocker` / `ready-for-human`.
- Worktrees live under `.red/tmp/workers/{id}/{N}-a{n}/worktree`; the worker
  liveness anchor is `.red/tmp/workers/{id}/worker.pid`.
- Claiming uses the three-layer scheme: local `mkdir` lock, GitHub label
  pre-check, and stale-lock boot sweep — the same scheme that keeps two named
  fleets on one backlog from double-claiming an issue. Inspect it with
  `claim_status`; cure a ghost claim with `claim_release`, never by editing
  labels by hand.
- The inner agent's canonical completion signals are
  `<promise>DONE</promise>` and `<promise>BLOCKED</promise>`.
- `plugins.dev.afk.validation` is the sole local validation authority. Its
  ordered `iteration`, `post_done`, and `landing` command lists are run only at
  those named moments; an undeclared moment is skipped loudly and `[]` is an
  explicit empty declaration. The engine never discovers or improvises a suite.
- `iteration` is handed to the inner agent while it writes. `post_done` runs at
  the branch's fork point after DONE, and a correction re-runs only its failed
  subset before folding back to the full declaration. `landing` runs before
  push/PR/queue. The merge queue is the CI-side final Validation moment and owns
  freshness against the merged result.
- The **Queue Custodian** owns an unlocked PR after Landing arms native merge
  intent and records the custody hand-off. Landing then ends: the Worker does
  not poll the merge, classify an ejection, or close the Ticket. A vanished
  intent wakes the Custodian's repair Worker through ordinary admission.
- The **Verdict** is the one pure failed-Validation decision. Checks, history,
  and environment facts enter; fault, budget effect, and park-now leave. There
  is no runtime classification hook. Concrete compiler, assertion, and guard
  evidence is branch fault at any duration; only an evidence-free sub-second
  failure may be suspect infrastructure. The declared
  `plugins.dev.afk.validation.subsecond_failures_are_branch_fault` policy beside
  the Validation moments makes even that fallback branch-owned.
- The **Park** has one door. `blocker-state` alone parses, writes, and clears the
  active blocker (malformed blocked records stay active and named), and every
  return to `ready-for-agent` calls `applyRequeue` with `machine` or `human`
  authority. Callers never reproduce its freshness, claim-sweep, Directive,
  body, or label sequence.
- The gate command is canonical. Workers run the exact commands handed to
  them and never self-impose stricter flags, extra lint restrictions, widened
  target sets, or a harder contract. If an error appears only under an extra
  check, reconcile it against the declared schedule before reporting a red
  `main`.
- `blocked:ci` leaves the completed PR open and escalates to `ready-for-human`;
  AFK does not re-run the inner agent for already-complete work waiting on CI.
- On DONE, completion sweep reclaims all attempt directories for that issue
  across workers; failure paths retain cheap artifacts and the pushed
  `afk/*` worker branch.

## Parallelization

`/afk` is trivially parallel: run another `/afk` in another terminal. Each run
gets a worker ID (`w` + 4 random `[A-Z0-9]` chars), separate worker files, and
the same claim safety. **The project's producer is the structured form of the same
parallelism** — `project_start` takes the runner, the selector and the base
branch, and applies several selectors as an ordered priority inside ONE producer
rather than as competing loops. Choose the width by disjointness; read
[`fleet.md`](./fleet.md) for the full rule.

## Stop Conditions

- Eligible queue drained -> `<promise>NO MORE TASKS</promise>` and exit 0, with
  a gate census when open non-Spec issues remain, including ready-labelled
  issues held for maintainer summon.
- `-n N` reached -> summary and exit 0.
- Runner exhaustion or transient runner failure -> bounded recovery for the
  current issue, then outer exit 75.
- Uncaught orchestrator error -> leave recoverable artifacts in place, exit 1,
  and print the recovery hint.

## Safety

See [`SAFETY.md`](SAFETY.md). The orchestrator and inner agent both inherit
those rules; violations abort the loop.

<supporting-info>

For failure-state playbooks and operator recovery procedures, see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

</supporting-info>
