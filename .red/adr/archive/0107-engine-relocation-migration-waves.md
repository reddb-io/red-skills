# 0107 — Engine relocation migrates by waves and proves drain before deletion

## Status

Superseded by ADR 0124. The expand-first waves produced an unconsumed engine;
the successor absorbs the proven dev implementation and deletes the twin.

superseded-by: 0124

## Context

The engine can only move if the AFK fleet keeps draining. A feature-flagged
parallel engine would create a long-lived double matrix and stale selection code.
The map instead locked an expand, migrate, contract sequence with small flips and
revert-PR rollback.

## Decision

The migration runs in four waves.

Wave 0 is enablers. Vendoring lands first. Readers learn both legacy JSON and
new TOON lanes. Contract scaffolding lands: castle exported types,
`.red/contracts/` docs, drift tests, and the `.red/tmp` guard-literal drift
test.

Wave 1 is expand. Red-castle grows the new engine behind unused entry points:
`src/engine/` skeleton, `enginePaths`, config reader, TOON lane writers,
`tracker/github/` adapter, labels-as-config, dual lease, Envelope and HITL
formats, runner registry, gate execution, landing and land-lock, worker state
machine, supervisor including elastic fleet, and lifecycle dispatcher.

Wave 2 is migrate. Flips happen one command at a time:

1. Monitor.
2. `go --once`.
3. `afk run`.
4. Fleet.

Each flip is a small PR. Rollback is a revert PR. There is no engine-select flag.

Before the final flip, the acceptance harness proves the new engine on real
work: claim, work, validate, land, and close a real Ticket; two-wide fleet
concurrency; monitor, statusline, and daily review rendering from new lanes.

The point of no return is proving drain: at least 20 real Tickets drained by the
new engine under the catches-and-heals criterion. Violations are acceptable only
when the system catches and heals them autonomously. Only then does Wave 3 open.

Wave 3 is contract. Delete the legacy dev-local engine, attempts apparatus,
`CORE_MODULE_MANIFEST`, dead env knobs, old lane writers, and legacy state paths.
Boot migration moves `state/afk/` to `state/castle/`. Docs and skill parity are
re-pointed. ask-red coverage is re-checked. Post-cutover cleanup such as legacy
spawn-builder retirement, `hermes` alias removal, escalation ladder, and
steering are normal follow-up Tickets drained by the new fleet.

Elastic fleet ships structurally in Wave 1. Escalation ladder and steering are
post-cutover additive policies.

## Consequences

- The system avoids a permanent engine-selection flag and double test matrix.
- Rollback is ordinary GitHub revert flow.
- Legacy deletion waits for empirical drain, not local confidence alone.
- The migration Spec can be sliced into AFK-drainable Tickets after these ADRs.

## Sources

- Wayfinder map #1875.
- Ticket #1883.
