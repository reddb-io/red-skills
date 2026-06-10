# State File Schema

Path: `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json`

```json
{
  "version": 1,
  "worker_id": "wZ2R4",
  "pid": 12340,
  "log": ".red/tmp/workers/wZ2R4/142-a1/afk.log",
  "started_at": "2026-05-16T12:00:00-03:00",
  "runner": "codex",
  "filter": { "kind": "prd|issues|all", "value": "42" },
  "total": 12,
  "done": 3,
  "failed": 0,
  "blocked": 0,
  "completed": [139, 140, 141],
  "queue": [143, 144, 145, 146],
  "current": {
    "number": 142,
    "title": "wire OAuth callback",
    "slug": "wire-oauth-callback",
    "worktree": ".red/tmp/workers/wZ2R4/142-a1/worktree",
    "handoff": ".red/tmp/workers/wZ2R4/142-a1/handoff.md",
    "started_at": "2026-05-16T12:14:00-03:00",
    "stage": "impl",
    "heartbeat_glyph": null,
    "heartbeat_pid": null,
    "runner": "codex",
    "retries": 0,
    "last_stream_line": "writing tests for callback handler"
  },
  "durations_seconds": [820, 940, 760],
  "envelope": { "posted": false }
}
```

State is updated atomically: write to `afk.state.json.tmp`, then `mv` over the original.
