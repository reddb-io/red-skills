# Monitor

`/afk monitor` is the readonly aggregated view across all live workers. It globs `.red/tmp/workers/*/*/afk.state.json`, verifies liveness via the orchestrator PID, and renders one section per active attempt.

Two modes:
- **TTY** — full box-drawing layout, refreshes every 3 s, Ctrl-C to exit.
- **Non-TTY** — one-shot compact dashboard (one sparkline + one line per worker), exit 0. Force with `--once` or `RED_AFK_MONITOR_COMPACT=1`.

The monitor also **mirrors each live worker onto the native task surface** (Claude Code tasks, or Codex monitor agent). This is **binding** — run the mirror every tick, even if just answering "how are we?". The mirror is idempotent and emits zero descriptors when nothing changed.

**Self-cancel** — after rendering the dashboard, if `live_workers == 0`, `CronDelete` every auto-monitor cron and exit.

**Task mirror** — pipe the tracked-task JSONL into `monitor --mirror-plan`, apply the emitted call plan via `TaskCreate`/`TaskUpdate`. The mirror is keyed by `worker_id:issue` so parallel workers each get exactly one task. On session reopen with workers still running, the tracked set is empty and `monitor --mirror-plan` reconciles cold, emitting `TaskCreate` for every live worker.

**Codex sink** — under Codex, `monitor --mirror-plan --runner codex` emits the same descriptors; if Codex grows a native task surface, use it; otherwise fall back to the dashboard + notice.
