# 0126 — The rsp resident is the single core; every surface is a client

- **Status**: accepted
- **Date**: 2026-07-28
- **Related**: ADR 0097 (tq as a mandatory host binary), ADR 0120 (castle MCP as the canonical interface), PRD #2647 (rsp adoption failures), Spec #2651 (executable charter)

## Context

Spec #2651 named the rsp MCP server as the canonical contact point for
token-efficient terminal work, and left four charter questions open: the hook's
transport, ownership of the elision store, behaviour where no MCP host is
running, and the migration order.

The tree already answers most of them. `apps/rsp/src/resident-server.ts` runs a
resident process behind a unix socket, registers itself through
`resident-client`, auto-spawns on demand, owns `RspElisionStore`, and keeps
telemetry and accounting in RedDB. The MCP server (`rsp_status`,
`rsp_compress`, `rsp_show`, `rsp_stats`) is a second surface over the same
behaviour, not a layer above it. The pre-exec hook, the wrappers, and the CLI
each reach the core their own way.

That leaves the real defect the PRD is about: the *core* is reachable through
several doors with different failure modes, so a host missing one door silently
loses elision instead of degrading. Naming the MCP the contact point would fix
the symptom for MCP-connected hosts and make it worse everywhere else — a
headless run, a cron lane, or a shell with no MCP host has no contact point at
all, and stdio round-trips would also sit inside the pre-exec latency budget.

## Decision

**The resident is the core. The MCP server, the CLI, the wrappers, and the
pre-exec proxy are all clients of it, with no privileged surface among them.**

1. **Transport** — every surface reaches the core over the existing resident
   socket. The MCP server stops being "the contact point" and becomes one more
   client, so an MCP-less host is a fully supported configuration rather than a
   degraded one.
2. **Store ownership** — the resident is the sole writer of the elision store
   and the telemetry lanes under `.red/state/rsp`. No surface writes them
   directly; concurrent writers were the reason handles could be minted without
   a recoverable payload.
3. **Headless and cron** — the resident auto-spawns on first use and exits on
   idle. A context with no MCP host still gets elision, summaries, and
   recovery. If the socket cannot be reached at all, every surface fails open to
   the raw command, preserving stdout, stderr, and exit status.
4. **Migration** — one cutover, all surfaces at once (maintainer decision
   2026-07-28). The staged alternative (wrappers first, proxy last) was
   considered and rejected: it keeps two cores alive across releases, and the
   split-brain window is itself the failure mode the PRD is trying to close. The
   cost is accepted explicitly — there is no intermediate rollback point, so the
   cutover must land behind a contract test that proves every surface reaches the
   same core, and behind the fail-open guarantee above.

## Consequences

- A single behavioural contract can be tested once and asserted for every
  surface: same summary, same `el:<id>` handle, same recovery bytes, whichever
  door the caller used.
- The MCP surface stays useful for agents without becoming load-bearing for
  humans, scripts, or headless lanes.
- The pre-exec path pays a local socket round-trip rather than a stdio MCP
  round-trip, keeping the latency budget while removing the in-process copy of
  the store.
- Big-bang has no partial rollback. The mitigation is contract-test coverage
  before the cutover lands and fail-open behaviour after it, not a staged
  release.
