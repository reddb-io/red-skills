# Memory graph is the substrate for codebase mapping

## Status

accepted.

## Context

PRD #103 chose RedSkills' **Engineering semantic graph** as the moat for
codebase mapping work. The product still needs parity with systems that commit
a public codebase artifact, but the source of truth cannot become a second
indexing system beside the Memory plugin.

The relevant project terms are already defined in `.red/CONTEXT.md`:

- **VCS-versioned memory graph**: the **Graph mode** memory store collections
  that opt into RedDB's git-for-data layer.
- **Public codebase map**: a committed JSON cache that materializes the public,
  repository-structure projection of that graph at `HEAD`.

RedDB's git-for-data overview (`../reddb/docs/vcs/overview.md`) is the
substrate capability this decision relies on: versioned collections opt into
VCS, commits pin MVCC snapshots, commit hashes are deterministic SHA-256 values,
and SQL can query historical state with `SELECT ... AS OF COMMIT|BRANCH|TAG`.

## Decision

The **VCS-versioned memory graph** is the substrate for codebase mapping.

The **Public codebase map** is a materialized view of that graph at `HEAD`, not
a separately generated artifact produced by a parallel pipeline. The live graph
remains the source of truth. The public JSON exists only as a presentation cache
for teammates and external readers who do not have a RedDB instance available.

Operationally, this means the public artifact is created by a dump verb over the
versioned graph projection. It is not edited by hand, and it is not regenerated
from a second scanner with its own semantics.

PRD #103 is the binding PRD where this decision was made. In its Human
Decisions, it explicitly adopted RedDB's native git-for-data layer as the
substrate and reframed the public map as a materialized view of the
VCS-versioned graph.

## Alternatives considered

- **Separate JSON regenerator pipeline.** Rejected because it duplicates
  `/memory:ingest`, creates a second source of truth, and misses the RedDB
  time-travel capability that makes the codebase map more than a static export.
- **Drop the public artifact entirely.** Rejected because RedSkills still needs
  a shareable, committed artifact for readers who do not run the Memory plugin
  or a local RedDB instance.
- **Ship the public JSON cache before proving the substrate.** Rejected in PRD
  #103 because the cache shape depends on what the graph actually contains.
  The substrate and internal graph-backed workflows need to settle first.

## Consequences

- The substrate decision comes first: durable and reasoning graph data must live
  in RedDB collections that can participate in VCS.
- The **Public codebase map** becomes a dump verb over the
  **VCS-versioned memory graph** at `HEAD`, rather than a peer pipeline.
- There is no second codebase-mapping pipeline to keep consistent with
  `/memory:ingest`; graph ingestion, graph reads, and public dumping all share
  one substrate.
- `AS OF` time-travel becomes possible as a later slice. Future codebase
  understanding surfaces can ask what the graph knew at a commit without
  redesigning the storage model.
- Freshness policy belongs at the graph boundary: pre-commit, AFK self-ingest,
  CI dump checks, and any later public-cache workflow should verify that the
  dumped view matches the versioned graph, not that a separate generator agrees
  with it.
