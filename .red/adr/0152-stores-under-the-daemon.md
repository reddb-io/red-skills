# 0152 — Stores are daemon-owned: brain is host-scoped, memory is per Project

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0005 (memory: local-first per repo — amended), ADR 0041 (red-ui consumed as third-party MCP), ADR 0144 §5 (client checkout is never an input), ADR 0147 (thin Plugin MCPs)
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

`red-memory` and `brain` were heavy MCPs each opening its own RedDB in the
session process — N sessions on one repo, N open handles, and the memory bundle
alone weighed 11 MB. Once every plugin's MCP is a thin ACP client (ADR 0147),
someone must hold the handle.

## Decision

**The daemon holds every store handle, once per host.** All four plugins route
through it. **Brain is global**: `~/.red/brain`, in the user's context, never per
repo. **Memory is per Project**: default `~/.red/memory/<project-id>` keyed by the
Project's GitHub identity; a repository may opt in through `.red/config.yaml` to
`./.red/memory` of the **human's checkout**, which the daemon opens only for the
interactive and ADR-editing modes. In spec-driven and ad-hoc modes a Worker
reaches memory through its ACP parent, never through the disk. Navigator indexes
join the same rule only after the daemon has a memory ceiling of its own; until
then they are off (ADR 0147 §4).

## Considered options

- Memory always in the checkout where the session runs, the daemon opening it
  wherever it is. Rejected: that makes the client checkout a daemon input.
- Both stores per repo, the daemon a proxy. Rejected: brain is the user's, not
  a project's, and a proxy over N handles saves nothing.
