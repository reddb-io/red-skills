# AS OF recall is read-only over RedDB VCS

## Status

accepted.

## Context

The Memory moat foundation includes VCS/time-travel memory so a coding agent can
answer what Memory knew at a historical point. RedDB already provides git-for-
data semantics: versioned collections, commits, branches, tags, and historical
queries through `AS OF`.

Memory has an existing tier policy: durable and reasoning graph data
participate in the VCS-versioned memory graph, while ephemeral data stays out.
AS OF recall should expose that substrate without turning historical reads into
mutable operational events.

## Decision

AS OF recall is a read-only recall query over a historical RedDB VCS reference.

The first user-facing API accepts RedDB VCS refs: commit hashes, branches, and
tags. It does not initially map Git refs to RedDB commits.

Historical recall reads only versioned durable/reasoning collections. It does
not include ephemeral/session/cache/event-log data, and it does not update
access bookkeeping, KV overlays, or doctor freshness state.

Implementation should use a read-only historical reader, such as a
`HistoricalMemoryStore`, that satisfies the recall engine's read interface
without exposing write methods. The mutable `MemoryStore` remains the current
state writer.

`memory graph commit` starts as an explicit CLI operation that creates RedDB VCS
commits for the versioned Memory graph. MCP may expose AS OF recall read paths
early, but commit creation stays CLI-only in the foundation cut to avoid
accidental snapshots from agents.

## Alternatives considered

- **Record access from historical recall.** Rejected because historical recall
  must be reproducible and side-effect free.
- **Map Git refs first.** Deferred because RedDB VCS references are the native
  substrate. Git alignment is useful later, but it adds ambiguous mapping and
  lifecycle questions to the first cut.
- **Expose MCP commit immediately.** Deferred because commits mutate the
  historical substrate and should start as an explicit operator action.
- **Extend mutable MemoryStore for AS OF reads.** Rejected because the risk of
  accidental writes/access updates is higher. A read-only reader makes the
  historical boundary visible in types and tests.

## Consequences

- `recall --as-of <ref>` must not call `recordAccess`.
- Historical recall tests need to prove repeatability: the same ref returns the
  same context without changing current access/freshness state.
- `memory graph commit` should report which versioned Memory collections are
  included and which ephemeral collections are skipped.
- Future UI and benchmark surfaces can ask "what did Memory know then?" without
  needing a separate snapshot/export pipeline.
