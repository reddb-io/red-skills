# Bootstrap & Cleanup

Before the first iteration, AFK:

1. Ensures `.red/tmp/` exists and is in `.gitignore`.
2. Generates a unique worker ID (`w` + 4 random chars).
3. Resolves the runner via detection cascade (flag > env > sniff > fallback).
4. Writes `worker.pid` (the orchestrator PID) as the liveness anchor.
5. Reads `SAFETY.md` rules and installs signal handlers.

Right after bootstrap, AFK:

1. **Orphan cleanup** — drains leftover `.red/tmp/work-*/` dirs and sweeps nested attempt dirs whose worker `worker.pid` is dead.
2. **Attempt cap** — per-issue prunes anything over the age or count cap (default 14 days / 5 attempts).
3. **Snapshot branch grace cleanup** — reaps remote `afk-attempts/*` for closed issues past the grace window (default 7 days).
4. **Unblock sweep** — promotes `blocked:dependency` issues to `ready-for-agent` when all their deps closed.
5. **Straggler check** — warns if unlabeled/needs-triage/needs-info issues exist.
