# 0143 — The Castle resident is project workflow truth

- **Status**: superseded by ADR 0144
- **Date**: 2026-08-13
- **Related**: ADR 0113 (Castle owns truth), ADR 0120 (Castle MCP), ADR 0126 (rsp resident core), ADR 0130 (`redskilled` host process truth), Spec #3799, Ticket #3803

## Context

The Castle MCP was resident only by accident: every stdio host loaded an engine,
opened GitHub adapters, renewed project registration, and started background
belts. Singleton leases prevented some duplicate effects, but they did not make
one process authoritative. Two sessions could carry different bundle versions,
pay for two heavy processes, and disagree during a handover.

The opposite authority already exists at host scope. `redskilled` sees every
project and therefore owns process birth, death, placement, limits, and resource
budgets. Giving it Castle semantics would let a host daemon interpret work from
repositories pinned to different bundle versions, reversing ADR 0130's
version-neutral boundary.

## Decision

**One versioned Castle resident owns workflow truth for one canonical project.**
The canonical project identity hashes Git's common directory, so the Primary
checkout and every sibling Worktree rendezvous on one runtime socket, spawn
lock, registry, and heavy PID. MCP stdio hosts are lightweight clients: they
publish schemas locally and multiplex calls to the resident.

The resident owns engine state, GitHub adapters, project registration renewal,
and every Castle background belt. Notifications cross the same versioned wire;
no client hosts an in-process fallback. A protocol-major mismatch returns the
typed `INCOMPATIBLE_RESIDENT_PROTOCOL` error before any engine call or spawn.

The shared resident lifecycle generalises rsp's proven socket, spawn-lock,
registry, version, and handover primitives. rsp keeps its established registry
payload and behaviour while using the same atomic store. Concurrent first
clients serialize birth under the spawn lock. A newer compatible bundle asks
the old resident to drain: every in-flight call either completes or is named as
pending within 30 seconds, after which one successor starts.

Idle exit is five minutes after the last activity and requires all four counts
to be zero: clients, Workers, in-flight calls, and armed obligations. A standing
drain is an armed obligation. Crashes leave no semantic fallback; the next
client reaps stale coordination under the shared lifecycle and starts one
successor.

The authority split is strict:

- `redskilled` remains host process and budget truth. It decides whether and
  where a Worker process exists and records host resource incidents.
- the Castle resident remains project workflow truth. It decides what work the
  project requests and interprets no host-wide capacity.

The Castle resident registers its own `castle-resident` resource target in the
same redskilled incident store, without copying command lines, environments, or
other forbidden diagnostic fields.

## Consequences

- Several MCP sessions and Worktrees share one project engine and GitHub cache.
- Bundle handover has a bounded, observable result instead of killing unknown
  calls or leaving two authorities alive.
- A resident outage is visible to every surface as the same wire/startup error;
  clients cannot hide it by executing project policy locally.
- Process and workflow debugging keep distinct owners: host questions route to
  `redskilled`; project execution questions route through the Castle MCP, whose
  calls reach the resident.
