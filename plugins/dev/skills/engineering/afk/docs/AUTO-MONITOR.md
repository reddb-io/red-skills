# Auto-Monitor Loop (Claude Code only — binding)

When `/afk` is invoked to spawn a worker (not the `monitor` subcommand), the agent schedules a recurring `/dev:afk monitor` cron inside the current Claude Code session. Death of every worker auto-cancels the cron.

Skip the auto-loop when:
- The invocation is `/afk monitor` (not a worker spawn).
- The invocation is `/afk --once` (user is already watching).
- `CronCreate` is unavailable (not Claude Code). Print guidance and continue.
