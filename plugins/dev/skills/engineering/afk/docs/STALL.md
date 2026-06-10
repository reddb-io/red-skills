# Solo-Run Stall Protection

A solo `/afk run` is protected by two in-process layers (armed only under no-sandbox isolation):

- **Attempt progress guard** — aborts when no NEW commit lands within `RED_AFK_ATTEMPT_TIMEOUT_S` (default 2700s), resetting on every commit. Maps to `blocked:stalled`.
- **Lane-idle reaper** — samples the agent lane mtime every `RED_AFK_STALL_POLL_S` (default 30s). A worker alive ≥ `RED_AFK_STALL_THRESHOLD_S` (default 600s) whose agent lane is idle ≥ the same is a candidate; past `RED_AFK_STALL_KILL_THRESHOLD_S` (default 1800s) and with no active descendant (`vitest`/`tsc`/`cargo`/build) or flat CPU, it is reaped tree-wide. Maps to `no-sentinel`.
