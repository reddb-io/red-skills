# Per-Worker & Per-Attempt File Layout

| Path | Purpose |
|---|---|
| `.red/tmp/workers/{id}/worker.pid` | Per-worker liveness anchor: the orchestrator's PID, written once at bootstrap. |
| `.red/tmp/workers/{id}/{N}-a{n}/worktree/` | Git worktree for issue `N` on attempt `n`. |
| `.red/tmp/workers/{id}/{N}-a{n}/afk.log` | Append-only plain log for this attempt. |
| `.red/tmp/workers/{id}/{N}-a{n}/agent.log.jsonl` | Clean agent lane — one `type=agent` JSONL record per assistant turn. |
| `.red/tmp/workers/{id}/{N}-a{n}/log.jsonl` | Firehose — every record of the attempt in the uniform JSONL envelope. |
| `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json` | State snapshot for this attempt. See `STATE-FILE.md`. |
| `.red/tmp/workers/{id}/{N}-a{n}/handoff.md` | Handoff file the inner agent reads. See `HANDOFF.md`. |
| `.red/tmp/workers/{id}/{N}-a{n}/validation.jsonl` | Structured JSONL sidecar from feedback validation. |
