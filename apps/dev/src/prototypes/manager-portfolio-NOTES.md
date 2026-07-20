# Manager portfolio transition prototype

> PROTOTYPE — delete the terminal shell after these decisions are absorbed into
> the Manager storage and runtime contract.

## Question

What concrete state machine best exposes Manager portfolio lifecycle,
effort-scoped leases, optimistic-generation conflicts, pause/resume, crash
recovery, checkpoint authority transfer, and partial cross-repository
publication before a storage engine is selected?

Run the explorer from the repository root:

```sh
pnpm --dir apps/dev prototype:manager-portfolio
```

The useful walkthrough is `r`, `1`, `2`, `g`, `e`, `r`, `c`, `v`, `3`, `x`,
`i`, `o`, `r`, `m`. After import, `o` shows the old host rejected by the retired
source replica; the following `r` acquires a fresh destination lease before
completion. The explorer redraws the complete focused effort, actor fencing
credentials, and portfolio authority after every action. Use `f` to show that
another effort can carry an independent lease.

## Answer exposed by the prototype

- Keep the five-state effort lifecycle small: `inbox`, `active`, `paused`,
  `completed`, and `abandoned`. Publication failure, crash, and generation
  conflict are transition results or projections, not extra lifecycle states.
- Put the writer lease and generation on each effort record. Every mutation
  presents the current authority epoch, and lease-owning mutations also present
  the exact lease token. Different sessions can write different efforts, while
  stale epochs, reused session IDs, stale tokens, and stale generations are all
  fenced independently.
- `end` is a local Manager transition: it pauses the effort and releases its
  lease without rolling back maps or cancelling owner work already published.
- A process crash does not get to rewrite durable state. It leaves an orphaned
  lease that a later session can recover only after liveness evidence identifies
  the old session as crashed; recovery itself advances the generation.
- Checkpoint import is an authority transfer, not synchronization. The transfer
  advances the authority epoch and effort generations, explicitly retires the
  source replica, invalidates source leases, and lets the destination acquire
  fresh leases without changing published facts.
- Cross-repository publication needs one durable projection per repository with
  a stable idempotency key. A later repository failure must not roll back an
  earlier successful map; retry fills the missing projection without duplicating
  the successful one.
- Completion must reject an effort while any in-scope repository projection is
  missing. The eventual runtime will add the stronger ADR 0109 acceptance and
  artifact-disposition checks on top of this prototype guard.

## Decisions this intentionally leaves open

1. What proves an orphaned lease is recoverable: host-session liveness, a lease
   timeout, an explicit operator takeover, or a combination?
2. Should checkpoint import preserve an `active` lifecycle with no lease, or
   force every non-terminal effort to `paused` until reconciliation completes?
3. Does the store expose effort-level compare-and-swap directly, or append
   transitions to a log and derive the current generation?
4. Is cross-repository publication represented as an outbox, a transition log,
   or fields embedded in each repository projection?
5. Which failed-attempt and tombstone details survive compaction, and which stay
   with tracker-owned artifacts and operational telemetry?

Those choices should be made from the next storage/checkpoint and recovery
decision tickets. The prototype demonstrates the required observable behavior
without treating its in-memory object shape as the storage schema.
