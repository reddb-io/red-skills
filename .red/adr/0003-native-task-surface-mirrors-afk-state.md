# Native task surface mirrors AFK worker state

## Status

accepted. **⚠ Stale on bash implementation:** AFK runtime was ported from bash (`afk.sh`, `supervisor.sh`, `monitor.sh`) to TypeScript (PR committed as c7131856); implementation details here describe the deleted bash runner. The task-mirroring decision and the per-runner adapter pattern remain valid; read `src/apps/dev/` for the current runtime.

`/afk` parallelises as independent OS processes (`afk.sh` launched with `nohup`,
optionally fanned out by `supervisor.sh`), coordinated through GitHub labels and
filesystem locks under `.red/tmp/`. Each (worker, issue) iteration writes an
`afk.state.json` snapshot, and the only feedback surfaces today are home-grown:
the `tput`-drawn *Live Header*, the `/afk monitor` dashboard (`monitor.sh`), and
a `CronCreate` auto-monitor loop that re-renders that dashboard into the session
every three minutes. The cron exists precisely because the orchestrator has no
native surface to report into.

Meanwhile the host harness already ships a first-class progress surface — the
background-task list shown in the Claude Code status bar, driven by
`TaskCreate` / `TaskUpdate` / `TaskList`, with an analogous primitive on Codex.
This ADR records the decision to render AFK progress there **without touching
the orchestration core**.

## Decision

**The orchestration layer is unchanged.** `afk.sh` / `supervisor.sh`, the
GitHub-label state machine, the `mkdir` claim locks, `nohup` persistence, and
`afk.state.json` as the single source of truth all stay exactly as they are.

**A thin, runner-specific presentation adapter mirrors `afk.state.json` into the
harness-native background-task surface.** On worker spawn the adapter registers
a native task; on each stage transition — already detected by *Stage Detection*
and already written to the state file — it pushes a `TaskUpdate`. The native
task is a **read-only mirror** of the state file, the same role `monitor.sh`
plays today, just on a native surface instead of `tput`.

**The mirror is agent-driven, not bash-driven.** `TaskCreate` / `TaskUpdate` are
harness tools, not shell commands; `afk.sh` cannot call them. The agent that
owns the session runs the mirror on the same tick the auto-monitor cron uses
today — bash emits state, the agent reflects it.

**The adapter is per-runner, mirroring the existing `runner-claude.md` /
`runner-codex.md` split.** Claude Code uses `TaskCreate`/`TaskUpdate`; Codex
uses its own equivalent, falling back to the current `monitor.sh` rendering
where no native task primitive exists.

**Tasks re-hydrate on session reopen.** A native task dies with the session; the
`nohup` worker does not. On the next session the adapter rebuilds the task list
by scanning live `.red/tmp/work-*/afk.state.json` whose `afk.pid` is still
alive, so the status bar recovers without operator action.

## Why

- **Portability is the point of the process-based core.** AFK runs from a bare
  terminal, Claude Code, or Codex, and survives the session closing. Migrating
  orchestration onto native subagents would couple it to one harness and throw
  away `nohup` persistence — the opposite of what AFK is for. Keeping the mirror
  as a *consumer* preserves every property the bash core already guarantees.
- **No second source of truth.** The mirror reads `afk.state.json` and writes
  only to the native surface. State can never disagree with the display, because
  the display derives from state — same invariant `monitor.sh` relies on.
- **The cron's job shrinks, not its lifecycle.** The auto-monitor tick already
  exists and already tears itself down when no workers remain (*Self-Cancel*).
  Reusing that tick to sync tasks adds the native surface without a new
  scheduler.
- **One abstraction cannot be native on both runners.** Claude Code and Codex
  expose different task APIs, so a single cross-runner primitive is a fiction.
  The per-runner adapter is the honest shape and it matches machinery the skill
  already has.

## Rejected alternatives

- **Migrate orchestration onto native subagents (the `Agent` tool / Codex
  multi-agent).** Rejected: native subagents are children of the session and die
  with it, breaking `nohup` persistence and bare-terminal operation; their API
  differs per harness, breaking portability. The visual win the operator wants is
  a *presentation* concern and does not require moving orchestration.
- **A single cross-runner task abstraction.** Rejected: there is no shared native
  task API across Claude Code and Codex. Pretending otherwise pushes the
  divergence into a leaky abstraction instead of an explicit per-runner adapter.
- **Have `afk.sh` call the task tools directly.** Impossible, not merely
  undesirable: `TaskCreate`/`TaskUpdate` are harness tools available to the
  agent, not commands on `PATH`. The mirror must run in the agent loop.
- **Drop the `tput` Live Header and `monitor.sh` once tasks exist.** Deferred,
  not adopted: those surfaces still serve bare-terminal and non-TTY/CI use where
  no native task list exists. The native mirror is additive.

## Consequences

- The auto-monitor cron tick gains a second job: read live state files and
  `TaskUpdate` accordingly. Its 3-minute cadence and self-cancel teardown are
  unchanged.
- A session-reopen re-hydration step is required — scan live `work-*` dirs,
  recreate one task per live worker, seed it from the current `stage`.
- Each runner needs its own adapter; Codex falls back to `monitor.sh` until/if
  it grows a usable native primitive.
- Native task death on session close is acceptable by construction: the state
  file is canonical, the task is disposable, and re-hydration restores the view.
- `monitor.sh` and the `tput` header remain the canonical surface for
  bare-terminal and CI runs; the native mirror is an additional consumer, not a
  replacement.
