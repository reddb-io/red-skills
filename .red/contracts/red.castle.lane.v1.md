# Castle Lane Record

schema id: `red.castle.lane.v1`

Exported TypeScript contract types: `CastleLaneRecord`, `CastleLaneKind`.

The castle lane is the append-only TOONL record family for engine events. Each
record carries `at` and `kind`, plus scoped identity fields when the event
belongs to a worker, supervisor, issue, or attempt.

Fields:

- `at`
- `kind`
- `worker_id`
- `supervisor_id`
- `issue`
- `attempt`
- `payload`
