# Attempt Completion & Termination Bounds

The `<promise>DONE</promise>` or `<promise>BLOCKED</promise>` sentinel the inner agent emits is the **canonical "attempt is over" signal**. sandcastle stops re-invoking the agent the moment one is observed. Three independent bounds cap a run that never signals:

- **`idleTimeoutSeconds`** (default **600 s**, env `RED_AFK_IDLE_TIMEOUT_S`) — per-iteration silence watchdog: an iteration producing no output for this long is aborted.
- **`maxIterations`** (default **12**, env `RED_AFK_MAX_ITERATIONS`) — sandcastle re-invocation ceiling: a run that never signals but keeps re-exploring can re-invoke up to this many times.
- **Commit-anchored attempt guard** (default **2700 s**, env `RED_AFK_ATTEMPT_TIMEOUT_S`, ADR 0044/0045) — proof-of-progress: a busy run that lands no NEW commit within the cap is aborted. Armed only under `none` (no-sandbox) isolation. Maps to `timeout` outcome → `blocked:stalled` / `ready-for-human`.

See `AGENT-PROMPT.md` *Background Tasks and Polling* — inner agents must cap every polling loop with a deadline.
