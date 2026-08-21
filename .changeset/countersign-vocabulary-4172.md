---
"@reddb-io/dev": patch
"@reddb-io/shared": patch
"@reddb-io/worker": patch
---

Countersign is the word across the Wave-1 verification artifacts (ADR 0156, #4172).

ADR 0136 owns **Verdict** as the gate's classifier of a failed Validation round.
ADR 0154's verification ledger named its rows "verdicts" too, so one pipeline
carried two meanings for one word. The ledger, its lane, its rows and every
identifier now say **Countersign**: the lane is
`.red/state/castle/countersigns.toonl` (migrated across all four lane
obligations — registry, writer, enforcement, census), the module is
`countersign-ledger.ts`, the shared question is
`@reddb-io/shared/land-countersign.js`, and the land refusal reasons are
`no-countersign`, `voided-countersign` and `stale-countersign`. The class enum is
unchanged. A new vocabulary ratchet refuses the retired spellings in live source,
and ADR 0136's own `Verdict`, `decideVerdict`, `gateVerdict` and
`staleHeadVerdict` are deliberately untouched.
