# Castle History Record

schema id: `red.castle.history.v1`

Exported TypeScript contract types: `CastleHistoryRecord`, `CastleHistoryEvent`.

The castle history record preserves the existing AFK `HistoryRecord` field set
and moves the lane to `state/castle/history.toonl`.

Fields:

- `ts`
- `epoch`
- `worker`
- `issue`
- `event`
- `duration_s`
- `runner`
- `merge_sha`
- `reason`
