---
"@reddb-io/protocol-acp": patch
"@reddb-io/shared": patch
"@reddb-io/worker": patch
"@reddb-io/redskilled": patch
---

A refused brief ends the turn and parks its Ticket, instead of echoing forever

The wire decoder spelled a brief-contract refusal as `return undefined`, and at
that door `undefined` means "no Ticket handoff" — the legal prompt-turn shape.
So a Ticket the contract rejected reached the Worker as an ordinary prompt: it
echoed, ended `no-workflow-outcome (end_turn)`, and left the item on
`ready-for-agent` for the planner to birth against every ~15s. Observed on an
operator's host: ~60 Workers on one item, twice.

The decoder now answers a decision — `absent`, `refused` (carrying the
contract's sentence), or a handoff — with `ticketHandoffFromMeta` kept as its
yes/no reading. A Worker handed a refusal ends the turn as
`refused at brief: <the contract's sentence>`, and the daemon's single park
door parks the Ticket under `blocked:spec` with that sentence quoted, so the
ready queue drains by one and the birth loop cannot re-form.
