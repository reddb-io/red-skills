---
name: afk
description: Autonomous loop that drains the `ready-for-agent` queue on the issue tracker. Each iteration claims an issue, runs it in an isolated worktree, executes with claude or codex, merges back to main, and closes the issue. Use when the user wants to run AFK execution, drain a Spec, hammer specific issues, or otherwise let agents grind through the backlog.
argument-hint: "[--spec N | --issues N,N,N] [--runner claude|codex|opencode] [--alternate] [--fallback-runner] [--request TEXT] [-n N] [--once] [--boot-only] | fleet [N] | fleet stop | monitor | dashboard | daily-review | weekly-review | retake N | reap"
---

# /afk

**The default lane for all tracked backlog work.** `/afk` is the modus
operandi; `/go` is the ad-hoc-only exception. Drain the agent-ready backlog by
letting the runtime select issues, create isolated worktrees, run the inner
agent, validate, land, close, and clean up.

The invoking LLM is responsible for setting `RED_AFK_RUNNER` to its own host
runner (`codex` from Codex, `claude` from Claude Code). Run the bundle, not the
source:

```bash
RED_AFK_RUNNER=<claude|codex|opencode> red-skills-dev <command> [params]
```

`afk.mjs` is a dedicated forwarder to the `dev` bundle. Every argument reaches
the orchestrator unchanged, so `run`, `monitor`, `fleet`, and a bare
`--issues 42` all use the same command surface. Runtime details and the full
operations contract live in [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).

## When To Use

- `/afk` - drain every open issue labelled `ready-for-agent`.
- `/afk --spec 42` - drain only tickets linked to Spec #42; the Spec issue
  itself is excluded.
- `/afk --issues 356,359,362` - drain an explicit issue list in that order.
- `/afk --runner codex` - pin a backend. This disables detection cascade and is
  mutually exclusive with `--alternate`.
- `/afk --alternate` - opt into round-robin runner rotation between issues.
- `/afk --fallback-runner` - opt into one mid-issue runner swap on
  `RUNNER_EXHAUSTED`; otherwise exhaustion uses bounded `blocked:quota`
  recovery and exits 75.
- `/afk --request "..."` or `/afk -r "..."` - add a special user request block
  to every inner-agent prompt in this run.
- `/afk -n 5` - cap the run at five issues; `-n 0` and omitted `-n` mean
  unlimited queue drain.
- `/afk --once` - single supervised iteration for debugging the prompt.
- `/afk --boot-only` - run boot sweeps and prechecks without claiming work.
- `/afk monitor` - read-only status board; read [`monitor.md`](./monitor.md)
  for the dashboard and native-task mirror contract.
- `/afk dashboard [--period 30d] [--json]` - process dashboard for open work,
  local workers, flow metrics, and DORA proxies.
- `/afk daily-review [--json]` / `/afk weekly-review [--json]` - operational
  review for the local daily or six-day window.
- `/afk retake 123 [--apply] [--json]` - issue resumption report; safe local
  setup only with `--apply`.
- `/afk fleet [N]` - supervise `N` concurrent workers; read
  [`fleet.md`](./fleet.md) before launch or stop operations.
- `/afk fleet stop` - gracefully stop the fleet supervisor and auto-monitor.
- `/afk reap` - run branch hygiene without starting a worker.

For GitHub Actions adoption, use [`actions-lane.md`](./actions-lane.md). The
same `/afk --issues N --runner opencode --once` lane runs as reusable workflow,
composite action, or local bundle invocation.

## Operating Contract

Read the focused reference before touching that concern:

- Runtime, sandcastle substrate, CLI forwarding, bootstrap, hard preconditions,
  issue selection, lifecycle, failure labels, per-issue loop, merge/close,
  runner fallback, completion bounds, stop conditions, and reporting:
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).
- Boot cleanup, stale attempts, branch reapers, and unblock sweep mechanics:
  [`docs/BOOT-SWEEPS.md`](./docs/BOOT-SWEEPS.md).
- State files, terminal-event envelope, attempt-outcome mapping, JSONL lanes,
  and failure snapshots: [`docs/ENVELOPE.md`](./docs/ENVELOPE.md).
- Handoff wrappers and inner-agent prompt materialisation:
  [`docs/HANDOFF.md`](./docs/HANDOFF.md) and
  [`AGENT-PROMPT.md`](./AGENT-PROMPT.md).
- Liveness, stall protection, and lane-idle rules:
  [`docs/LIVENESS.md`](./docs/LIVENESS.md).
- Config, env overrides, lifecycle hooks, sandbox/runner/model settings, and
  backpressure commands: [`docs/CONFIG.md`](./docs/CONFIG.md).
- Safety rules for shell and git actions: [`SAFETY.md`](SAFETY.md).

## Load-Bearing Rules

- Tracked work belongs in `/afk`. An empty `ready-for-agent` queue with a
  non-empty open backlog is a flow bug to surface with a gate census, not a
  clean "nothing to do" stop.
- Dependencies use `req:N` edge labels plus `blocked:dependency`; human gates
  use `## Current blocker` / `ready-for-human`.
- Worktrees live under `.red/tmp/workers/{id}/{N}-a{n}/worktree`; the worker
  liveness anchor is `.red/tmp/workers/{id}/worker.pid`.
- Claiming uses the three-layer scheme: local `mkdir` lock, GitHub label
  pre-check, and stale-lock boot sweep.
- The inner agent's canonical completion signals are
  `<promise>DONE</promise>` and `<promise>BLOCKED</promise>`.
- The gate command is canonical. Feedback plus the operator's
  `afk.backpressure` commands are the sole validation authority; workers run
  those exact commands and never self-impose stricter flags, extra lint
  restrictions, widened target sets, or a harder contract than the gate defines.
  If an error appears only under an extra check, reconcile it against the real
  gate command before reporting a red `main`.
- `blocked:ci` leaves the completed PR open and escalates to `ready-for-human`;
  AFK does not re-run the inner agent for already-complete work waiting on CI.
- On DONE, completion sweep reclaims all attempt directories for that issue
  across workers; failure paths retain cheap artifacts and push the
  `afk-attempts/*` snapshot.

## Parallelization

`/afk` is trivially parallel: run another `/afk` in another terminal. Each run
gets a worker ID (`w` + 4 random `[A-Z0-9]` chars), separate worker files, and
the same claim safety. Choose fleet width by disjointness; read
[`fleet.md`](./fleet.md) for the full rule.

## Stop Conditions

- Queue drained -> `<promise>NO MORE TASKS</promise>` and exit 0, with a gate
  census when open non-Spec issues remain.
- `-n N` reached -> summary and exit 0.
- Runner exhaustion or transient runner failure -> bounded recovery for the
  current issue, then outer exit 75.
- Uncaught orchestrator error -> leave recoverable artifacts in place, exit 1,
  and print the recovery hint.

## Safety

See [`SAFETY.md`](SAFETY.md). The orchestrator and inner agent both inherit
those rules; violations abort the loop.
