# 0124 — Castle crossing absorbs the proven engine and deletes the twin

- **Status**: accepted
- **Date**: 2026-07-21
- **Amends**: ADR 0102 (the dev remainder is defined by the host-adapter criterion)
- **Supersedes**: ADR 0107 (unused-engine expand/migrate/contract waves)
- **Preserves**: ADR 0106 (published AFK config names and destination ownership)
- **Related**: ADR 0113 (castle owns truth; dev owns the host boundary), ADRs 0116–0119 (harvested twin decisions), ADR 0125 (ownership drift ratchet)

## Context

ADR 0102 chose the right destination: red-castle owns the GitHub-aware AFK
engine and dev remains the agent-facing skin. Its list of things left in dev was
not a completion criterion, though. A module could stay on that list while still
owning Worker, Ticket, Lane, or PR policy and control flow. The result was a
half-migration with no falsifiable signal that dev still contained engine
behaviour.

ADR 0107 then prescribed four migration waves. Its expand wave required an
unused castle engine to be built before the proven dev implementation crossed.
That produced two implementations: the dev engine that drained real work and a
castle twin that encoded some useful new decisions but had never carried the
production drain. Treating the unconsumed twin as the target would discard the
proven implementation; deleting it without review would also discard decisions
worth keeping. Tickets #2231 and #2245 classified those differences before this
cutover decision.

ADR 0106 is not the source of the failure. Its ownership destinations still
stand, and its published names — `plugins.dev.afk.*`, compatibility `afk.*`, and
`RED_AFK_*` — remain frozen through the crossing.

## Decision

**Cross by absorbing the proven dev implementation into castle, then delete the
unconsumed twin. Do not expand the twin into a second engine before proof.**

The crossing proceeds one coherent engine verb at a time. For each verb:

1. start from the implementation that currently drains real work in dev;
2. incorporate only the twin decisions that were deliberately harvested;
3. relocate that implementation behind castle's contract;
4. reduce the dev entry point to a host adapter or remove it; and
5. delete the corresponding unconsumed twin and dev-local engine path in the
   same bounded crossing.

There is one runtime authority throughout. No engine-selection flag, parallel
production matrix, or unused expand wave is introduced. A crossing is complete
only when its touched-package checks pass and the ownership ratchet in ADR 0125
no longer reports that verb in dev.

ADR 0102's phrase “remaining dev plugin surface” is therefore amended by a
criterion, not another inventory. A dev module may remain only when it is a
**host adapter**: it renders castle-produced truth, translates host-facing CLI
or skill UX into a castle contract, or enforces castle-owned policy through an
agent-host mechanism. It may not decide engine policy or branch control flow on
Worker, Ticket, Lane, or PR state. Hybrid modules split at that seam, as ADR
0113 requires.

The reviewed twin differences keep the dispositions recorded by ADRs 0116–0119
and their source decisions: harvest fail-closed in-process config, retired-key
tombstones, sibling-visible cascade outcomes, and cheap-first unified gate
verdicts; keep dev's out-of-band sensitive-path approval, close-before-cascade
ordering, and canonical hardcoded triage vocabulary. Already-proven cleanup
error reporting and exact-merge-SHA rebases cross with the implementation.

## Consequences

- ADR 0107 is superseded and archived; its expand-first sequence and 20-Ticket
  twin-drain threshold are no longer migration gates.
- ADR 0102 remains the ownership boundary, sharpened by a falsifiable
  host-adapter criterion rather than a leftover list.
- ADR 0106 survives intact. Crossing config cannot rename the published AFK
  vocabulary or reverse the ownership destinations it fixed.
- Proof attaches to each absorbed production verb. The migration no longer asks
  an unused implementation to become authoritative merely because it was built
  first.
- Rollback remains an ordinary revert of a bounded crossing, without reviving a
  permanent engine selector.

## Sources

- Ticket #2236.
- Boundary and cutover study #2231.
- Ownership-test draft #2233.
- Config conflict #2244.
- Twin-decision disposition #2245.
