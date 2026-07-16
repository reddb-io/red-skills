# Castle HITL Card

schema id: `red.castle.hitl-card.v1`

Exported TypeScript contract types: `CastleHitlCard`,
`CastleHitlCardPrStatus`, `CastleHitlCardAction`.

The castle HITL card keeps the existing decision card v1 shape for
ready-for-human issues. Issue and PR content remain display data; command
parsing only happens on trusted human comments.

Fields:

- `issueNumber`
- `issueTitle`
- `issueUrl`
- `pendingDecision`
- `prStatus`
- `updatedAt`
