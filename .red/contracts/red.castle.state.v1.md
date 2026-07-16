# Castle State Snapshot

schema id: `red.castle.state.v1`

Exported TypeScript contract types: `CastleStateSnapshot`, `CastleStateKind`.

Castle state snapshots are TOON documents under `state/castle/`. They describe
the current worker or supervisor state without requiring readers to parse prose
logs.

Fields:

- `kind`
- `id`
- `version`
- `updated_at`
- `worker_id`
- `supervisor_id`
- `runner`
- `pid`
- `started_at`
- `current`
- `queue`
- `completed`
- `envelope`
