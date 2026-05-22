# Fleet supervisor is runner-portable; session observability degrades per runner

`/afk fleet` is implemented by `supervisor.sh`: a bash process manager that
maintains a target number of independent `/afk` workers, writes PID/stop/circuit
state under `.red/tmp/`, and lets normal workers own issue claiming, worktrees,
validation, merge, push, and close.

The skill text previously treated fleet mode as Claude-Code-only because the
launch/stop wrapper also scheduled and cancelled a Claude Code session cron for
the auto-monitor loop. That conflated two separate concerns:

- the **Fleet supervisor**, which is portable process orchestration
- the **Auto-monitor loop** and **Task mirror**, which are runner-specific
  presentation surfaces

## Decision

The **Fleet supervisor is runner-portable**. Codex, Claude Code, and a bare
terminal may all launch and stop `supervisor.sh` as long as the normal AFK hard
preconditions pass.

Runner-specific observability must degrade independently:

- Claude Code may schedule the auto-monitor cron and mirror workers onto the
  native task list when `Cron*` and `Task*` tools are available.
- Codex may launch/stop the supervisor without a cron. Until Codex exposes a
  native background-task surface, its task mirror falls back to the `monitor.sh`
  dashboard/logs. In the Codex TUI, the launch wrapper may also spawn one
  read-only Codex monitor agent for the fleet: it periodically renders
  `monitor.sh --once`, auto-closes when no supervisor or live workers remain,
  and can be closed manually without affecting workers.
- A missing cron/task primitive is not a launch blocker. It only changes the
  user-facing monitor instructions.

When fleet is invoked from Codex, the wrapper should launch the supervisor with
`RED_AFK_RUNNER=codex` so child workers are deterministic and do not fall through
to `supervisor.sh`'s historical `claude` fallback.

`/afk fleet stop` is also portable: it should touch
`.red/tmp/afk-supervisor.stop`, wait for the supervisor PID to exit, and skip any
unavailable cron teardown with an explicit degrade message.

## Why

- **The existing supervisor already has the right portability boundary.** It is
  plain bash plus OS processes and does not call Claude Code or Codex-native
  APIs.
- **Observability should not authorize execution.** Cron and task surfaces make
  progress easier to see, but worker state is already canonical in
  `afk.state.json`, the supervisor state file, and logs.
- **Codex has an agent UI, not a task API.** The right Codex-native feedback
  surface today is a read-only monitor agent, not pretending the Claude
  `TaskCreate`/`TaskUpdate` API exists.
- **The previous Claude-only rule blocked valid Codex operation.** Codex lacks a
  native task/cron surface today, but that does not prevent `nohup` workers,
  claim locks, circuit breaker, stop-file shutdown, or monitor rendering from
  working.
- **Explicit runner propagation avoids surprising child behavior.**
  `supervisor.sh` currently defaults `RED_AFK_RUNNER` to `claude`; Codex fleet
  launch must override that rather than depending on process-tree detection.

## Rejected alternatives

- **Keep fleet Claude-Code-only until Codex has native task UI.** Rejected:
  native task UI is a presentation feature, not a process-management
  prerequisite.
- **Require auto-monitor cron for fleet launch.** Rejected: cron availability is
  runner/session-specific and should degrade to manual `monitor.sh` or log
  inspection.
- **Replace AFK workers with Codex sub-agents.** Rejected: sub-agents are a
  session presentation/execution surface, while AFK workers are detached OS
  processes supervised by `supervisor.sh`.
- **Let Codex fleet rely on ambient runner detection.** Rejected: the supervisor
  is a long-lived detached process and should receive an explicit runner choice
  from the launch wrapper.

## Consequences

- The AFK skill contract must remove the Codex launch refusal and describe
  runner-specific monitor degradation instead.
- Fleet stop must be idempotent and portable, with cron cleanup attempted only
  when the host exposes cron tools.
- Tests should cover Codex fleet launch/stop behavior, including
  `RED_AFK_RUNNER=codex` propagation and no-op cron handling.
- ADR 0003 still governs task mirrors: Codex does not create native tasks until
  a Codex task primitive exists; it uses the monitor fallback in the meantime.
- Codex fleet launch should create at most one monitor agent per fleet launch;
  the agent is read-only and disposable.
