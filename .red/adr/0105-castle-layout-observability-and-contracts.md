# Castle lanes use state/castle, structured TOON, and published contracts

## Status

Accepted. Records the locked layout, logging, and data-contract decisions from
wayfinder map #1875 and source Tickets #1881, #1886, and #1887.

## Context

Engine relocation changes both ownership and shape of runtime files. ADR 0098
requires `.red/tmp/` to remain disposable and durable machine state to live
under `.red/state/`. ADR 0097 requires machine-readable append streams to use
TOONL and snapshots to use TOON.

The layout prototype on branch `prototype/red-tmp-layout` was ratified as the
baseline for the relocated engine.

## Decision

The durable namespace is `state/castle/`. The old `state/afk/` namespace
boot-migrates to it. AFK remains the skill and command name in the dev skin;
castle is the engine-internal state namespace.

Live process artifacts live in tmp lanes:

- `tmp/supervisors/<id>/`
- `tmp/workers/<workerId>/`
- `tmp/monitors/<id>/`
- `tmp/worktrees/workers/<workerId>-<ticket>/`

Human worktree lanes such as `manual`, `feedback`, `landing`, `rebase`,
`cascade`, `adopt`, `reconcile`, and `docs` keep their homes under
`tmp/worktrees/`.

There is one `workers/` root with `kind` (`afk`, `go`, or `scout`) recorded in
`state.toon`; per-kind roots such as `go-workers/` and `scout-workers/` die.

The liveness lane remains separate as `liveness.toonl`. It is not folded into
`worker.log.toonl`, preserving the un-poisonable liveness property from ADR
0083.

Structured engine lanes are append-only TOONL records in the family
`{at, kind, ...payload}` with namespaced `kind` values such as
`worker.claimed`, `worker.steered`, `supervisor.scaled`, and
`supervisor.retired`. Human prose log files are not dual-written; human views
render on read from structured lanes. Raw agent bytes stay TOON-exempt and
issue-scoped under the worker worktree as `agent.log`.

Published contracts are:

- `red.castle.lane.v1` for the engine record family.
- `red.castle.state.v1` for worker and supervisor `state.toon` snapshots.
- The existing HistoryRecord field set, moved to `state/castle/history.toonl`.
- `red.castle.validation.v2`, preserving the `red.afk.validation.v1` fields but
  serializing them as TOON records in `validation.toonl`.
- Existing Envelope and HITL card `v1` formats, emitted by the castle.

Executable TypeScript types live under `packages/red-castle/src/engine/contracts/`.
Readable contract docs live under `.red/contracts/`. A drift test binds the two.

Readers learn both legacy JSON and new TOON formats before cutover. The new
engine writes only the new format; legacy lanes expire by TTL. There is no
dual-write window.

## Consequences

- `.red/tmp/` remains disposable.
- Statusline, `tq`, shell tooling, and humans in issue comments are the external
  contract consumers; monitor is castle-internal.
- Monitor, statusline, and daily/weekly review must render correctly against new
  lanes before the legacy write path is deleted.

## Sources

- Wayfinder map #1875.
- Tickets #1881, #1886, and #1887.
