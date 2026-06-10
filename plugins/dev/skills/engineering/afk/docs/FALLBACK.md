# Runner Fallback

Default behaviour is **no rotation and no fallback** — the resolved runner is used for every issue. `RUNNER_EXHAUSTED` routes through bounded recovery as `blocked:quota`, with a cap (default 3 retries), then escalates to `ready-for-human` at/over the cap.

- `--alternate` enables round-robin rotation (claude → codex → claude → …). Mutually exclusive with `--runner`.
- `--fallback-runner` enables mid-issue swap when the active runner returns `RUNNER_EXHAUSTED`. Without it, exhaustion is terminal and routes through bounded recovery.
