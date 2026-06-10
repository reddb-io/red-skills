# Heartbeat & Liveness

The issue-thread heartbeat (`:one:` / `:two:` cycling) was removed. Local liveness is signalled by:

- **Inner-agent stream** — captured and surfaced via `afk.log` + the JSONL lanes.
- **Clean agent lane** (`agent.log.jsonl`) — one `type=agent` record per turn, never synthetic; the true liveness signal.
- **State-file mtime** — bumped on every state update.
- **Periodic orchestrator heartbeat** — every `RED_AFK_HEARTBEAT_S` (default 60s), appends `[heartbeat] stage:tests t+00:14:02 cpu=12% rss=420M` to `afk.log`.

When tailing a worker, read `agent.log.jsonl` for real liveness; `afk.log` carries the periodic heartbeat so a silent agent still produces one line per minute.
