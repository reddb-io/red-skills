# Fleet Mode

`/dev:afk fleet [N]` and `/dev:afk fleet stop` are the user-facing commands:

**Launch:**
1. Resolve runner (explicit `--runner` > `RED_AFK_RUNNER` > sniff > `claude`).
2. Pre-check `.red/tmp/afk-supervisor.pid` — refuse if a live supervisor already runs.
3. Launch the supervisor and wait for the PID file to appear.
4. Attach the best available monitor (Claude cron, Codex agent, or manual).
5. Print the supervisor PID and monitor status.

**Stop:**
1. Liveness check on `.red/tmp/afk-supervisor.pid`.
2. Touch `.red/tmp/afk-supervisor.stop` if alive.
3. Wait up to 30 s for the PID file to disappear.
4. Tear down runner-specific monitors (Claude cron, Codex agent).

The supervisor handles respawn, circuit breaker (fast deaths inside a window park the slot), passive stall detector (samples agent lane mtime), hard stall reaper (irreversible kill for genuinely stuck workers, gated behind a busy predicate), and per-slot build isolation.

**Circuit trip** — when `CIRCUIT_K` fast deaths occur inside `CIRCUIT_WINDOW_S`, the supervisor sweeps affected attempt dirs, posts `discarded` envelopes on affected issues, and restores label state (`ready-for-agent` + `runner-error`).
