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

```
RED_AFK_RUNNER=<claude|codex> node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" <command> [params]
```

The environment variable `RED_AFK_RUNNER` must match the host runner. Commands: `run`, `monitor`, `dashboard`, `daily-review`, `weekly-review`, `retake`, `fleet`, `reap`, `__supervise` (supervisor only).

## When To Use

- `/afk` — drain every issue labelled `ready-for-agent`.
- `/afk --prd 42` — only issues that reference PRD #42.
- `/afk --issues 356,359,362` — explicit list, in order.
- `/afk --runner codex` — pin a backend.
- `/afk --alternate` — round-robin runner rotation between issues (see `FALLBACK.md`).
- `/afk --fallback-runner` — swap runners on `RUNNER_EXHAUSTED` (see `FALLBACK.md`).
- `/afk --request "..."` — add a special user request to every inner-agent prompt.
- `/afk -n 5` — cap at five issues.
- `/afk --once` — single iteration (debug mode).
- `/afk --boot-only` — run bootstrap then exit.
- `/afk monitor` — readonly aggregated view of all live workers (see `MONITOR.md`).
- `/afk dashboard [--period 30d] [--json]` — readonly process dashboard.
- `/afk daily-review [--json]` — readonly daily operational review.
- `/afk weekly-review [--json]` — readonly six-day operational review.
- `/afk retake 123 [--apply] [--json]` — issue resumption report.
- `/afk fleet [N]` — launch supervisor maintaining N workers (see `FLEET.md`).
- `/afk fleet stop` — gracefully shut down a running fleet.
- `/afk reap` — run branch hygiene without starting a worker (see `REAPER.md`).

## Parallelization

Run `/afk` from multiple terminals — no flags, no coordination. Each spawns its own worker with a unique ID (literal `w` + 4 random chars) for tailing or killing.

## Hard Preconditions

The skill refuses to start if any of these fail:

- `git remote -v` shows only SSH remotes (reject HTTPS).
- `gh auth status` succeeds.
- Repo has a `main` branch and `git -C primary log -1 main` works.
- Issue tracker label `ready-for-agent` exists (point at `/triage` if not).
- `pnpm` is on PATH.

## Core Loop

For each issue:

1. **Claim** — remove `ready-for-agent`, add `running`.
2. **Worktree** — branch off the base (see `WORKTREE.md`).
3. **Handoff** — materialize issue, prior attempts, human guidance (see `HANDOFF.md`).
4. **Inner agent** — invoke sandcastle; agent emits `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`.
5. **Feedback** — run `test`, `typecheck`, `lint`, `build` with pnpm on touched scopes.
6. **Merge** — land onto base (or PR if unlocked; see `LANDING.md`).
7. **Close** — post validation comment, `gh issue close`, delete remote branch.
8. **Cleanup** — drop worktree, retain attempt logs.

Attempt directories live under `.red/tmp/workers/{id}/{N}-a{n}/`. On failure they are preserved; on DONE they are reclaimed immediately.

## Execution Substrate (ADR 0033)

AFK uses [`@ai-hero/sandcastle`](https://github.com/mattpocock/sandcastle) to spawn the inner agent. See `AGENT-PROMPT.md` for the agent's contract.

## Monitoring & Stop Conditions

Live workers write state to `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json` (see `STATE-FILE.md`). Run `/afk monitor` to see progress across all workers (see `MONITOR.md`).

Stop conditions: queue drained (exit 0) → `-n N` reached (exit 0) → runner exhaustion (exit 75) → uncaught error (exit 1).

</what-to-do>

<supporting-info>

## Bundled Reference Material

Detailed guidance on specific topics — consult on demand:

**Core Concepts & Contracts**

- **`AGENT-PROMPT.md`** — inner agent's contract, termination bounds, polling rules.
- **`SAFETY.md`** — binding shell-action rules for orchestrator and inner agent.
- **`runner-{claude,codex,opencode}.md`** — per-runner spawn commands, error strings, exhaustion detection.

**State & Files**

- **`FILE-LAYOUT.md`** — per-worker and per-attempt file layout.
- **`STATE-FILE.md`** — state snapshot schema.
- **`HANDOFF.md`** — handoff file template the inner agent reads.
- **`VALIDATION.md`** — validation sidecar JSONL format.

**Issue Lifecycle & Outcomes**

- **`LIFECYCLE.md`** — state machine, dependency unblock mechanisms.
- **`OUTCOMES.md`** — attempt outcomes and recovery caps.
- **`ENVELOPE.md`** — terminal-event envelope schema.
- **`BLOCKER.md`** — current blocker state for human gates.
- **`DEPENDENCIES.md`** — `req:N` edge labels and promotion mechanics.

**Execution & Bounds**

- **`BOUNDS.md`** — termination bounds (idle timeout, max iterations, commit-anchored guard).
- **`HEARTBEAT.md`** — liveness signals.
- **`STALL.md`** — solo-run stall protection (attempt guard, lane-idle reaper).

**Configuration & Control**

- **`ENVIRONMENT.md`** — environment variables and overrides.
- **`CONFIG.md`** — configuration schema and lifecycle hooks.
- **`BACKPRESSURE.md`** — backpressure gate for additional feedback checks.
- **`MERGE-GATE.md`** — merge-gate policy and review handling.

**Advanced Topics**

- **`FALLBACK.md`** — runner fallback and round-robin rotation.
- **`WORKTREE.md`** — worktree base resolution (ADR 0031).
- **`LANDING.md`** — lock-toggled landing (ADR 0030).
- **`FLEET.md`** — fleet mode, supervisor, circuit breaker.
- **`MONITOR.md`** — monitor view and task mirroring.
- **`REAPER.md`** — on-demand branch reaper.
- **`BOOTSTRAP.md`** — bootstrap and cleanup phases.
- **`AUTO-MONITOR.md`** — auto-monitor loop (Claude Code only).

</supporting-info>
