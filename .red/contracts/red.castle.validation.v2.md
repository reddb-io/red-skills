# Castle Validation Record

schema id: `red.castle.validation.v2`

Exported TypeScript contract types: `CastleValidationRecord`,
`CastleValidationStatus`.

The castle validation sidecar preserves the `red.afk.validation.v1` fields and
serializes them as TOON records in `validation.toonl`.

Fields:

- `schema`
- `name`
- `status`
- `command`
- `exitCode`
- `durationMs`
- `summary`
