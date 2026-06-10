# Environment Variables & Configuration

Key overridable env vars (see `.red/config.yaml` under `afk:` for defaults):

- `RED_AFK_RUNNER` — caller runner identity (`claude` / `codex` / `opencode`).
- `RED_AFK_IDLE_TIMEOUT_S` — per-iteration silence watchdog (default `600` s).
- `RED_AFK_MAX_ITERATIONS` — sandcastle re-invocation ceiling (default `12`).
- `RED_AFK_ATTEMPT_TIMEOUT_S` — commit-anchored progress guard (default `2700` s).
- `RED_AFK_RETRY_QUOTA`, `RED_AFK_RETRY_CRASH`, `RED_AFK_RETRY_MERGE`, `RED_AFK_RETRY_RUNNER_TRANSIENT`, `RED_AFK_RETRY_POLICY` — recovery caps.
- `RED_AFK_STALL_THRESHOLD_S`, `RED_AFK_STALL_KILL_THRESHOLD_S`, `RED_AFK_STALL_POLL_S` — fleet stall detection.
- `RED_AFK_ATTEMPT_TTL_S`, `RED_AFK_ATTEMPT_KEEP` — boot-time attempt dir retention.
- `RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S` — remote snapshot-branch retention after completion.
- `RED_AFK_HEARTBEAT_S` — periodic orchestrator heartbeat interval (default `60` s).
