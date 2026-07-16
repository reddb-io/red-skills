# Castle Envelope

schema id: `red.castle.envelope.v1`

Exported TypeScript contract types: `CastleEnvelope`, `CastleEnvelopeSection`,
`CastleAttemptStatus`.

The castle envelope keeps the existing terminal attempt envelope v1 shape. It
records the terminal attempt status, summary fields, and optional rendered
sections.

Fields:

- `status`
- `worker`
- `duration`
- `diff`
- `attempt`
- `mergeSha`
- `sections`
