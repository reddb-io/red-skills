# 0145 — ACP is the RedSkills agent fabric

- **Status**: accepted
- **Date**: 2026-08-14
- **Related**: ADR 0082 (ACP runner direction), ADR 0120 (MCP-first Castle surface), ADR 0123 (MCP-first boundary), ADR 0142 (`redskilled` public name), ADR 0144 (`redskilled` control plane)

## Context

RedSkills previously treated coding agents as one-shot CLIs, exposed workflow
through MCP, and introduced a private Castle-resident wire for project state.
ACP already supplies bidirectional sessions, updates, cancellation, plans,
permissions, filesystem and terminal requests, capability negotiation, and
namespaced JSON-RPC extensions. Using it only at an editor edge would retain
the internal protocol and ownership seams this redesign exists to remove.

## Decision

**ACP is the sole agent protocol throughout the RedSkills control and execution
chain.** `redskilled` presents the public RedSkills identity as an ACP Agent and
acts as an ACP Client of Workers. Every Worker is an ACP Agent to its parent and
may be an ACP Client of child coding agents. All generative work runs in an
admitted Worker; the daemon itself contains no model runtime.

1. A generic ACP client receives the complete RedSkills workflow through core
   sessions, prompts, slash commands, plans, tool-call updates, cancellation,
   and permissions. Deterministic operations additionally use advertised
   `_redskills/*` extension methods with schemas and version/capability data in
   `_meta.redskills`. MCP and CLI surfaces are stateless adapters and ACP
   clients of `redskilled`; an extension never unlocks a capability unavailable
   through ACP core.
2. RedSkills supports ACP v1 and ACP v2 as production contracts. Because ACP v2
   draft revisions may share `protocolVersion: 2` while changing incompatibly,
   every v2 revision RedSkills ships gains a maintained adapter and a required
   RedSkills-namespaced revision identifier. A v2 peer that omits or offers an
   unknown draft revision is refused; this restriction does not apply to a
   conforming generic ACP v1 peer.
3. ACP protocol version is independent of the **RedSkills wire major**.
   `redskilled`, MCP adapters, and Workers interoperate across all minor and
   patch differences inside one RedSkills major; additions must therefore be
   capability-discovered and compatible. Cross-major workflow traffic is
   refused before session or work state crosses the wire.
4. A major upgrade is a quiescent handover: the old daemon stops admission,
   drains or terminally accounts for live Workers, flushes pending GitHub
   writes, checkpoints state, and exits before the new major migrates state and
   assumes the one endpoint. Two majors never concurrently own Workers,
   Projects, or the GitHub budget.
5. `redskilled` owns the durable ACP session journal and deterministic routing.
   A workflow Worker may serve several related turns and can be replaced from
   daemon-owned observable history and checkpoints; provider-native sessions
   are evidence or resume optimizations, never public session truth.
6. Permission requests are policy-first. An attached authorized client may
   answer within its capability scope. Without one, pre-authorized actions
   proceed and uncovered decisions checkpoint or terminate the Worker and use
   the ordinary HITL path; a Worker never waits indefinitely for reconnection,
   and absence never means approval.
7. Reconnectable local ACP uses one control endpoint per authority: Unix sockets
   on Linux and Windows Named Pipes on Windows, with a known daemon endpoint
   and a daemon-assigned endpoint per Worker. ACP over stdio remains the public
   edge for editors that launch an Agent subprocess and the natural edge for a
   directly launched child agent. Transport changes no method or ownership.

## Consequences

This record amends ADRs 0120 and 0123: MCP remains a complete supported surface,
but it is an adapter over the ACP-owned core rather than the canonical internal
boundary. It also amends ADR 0142: `redskilled` is the public RedSkills ACP Agent
as well as the name behind MCP projections. Adapters own no state, GitHub calls,
Worker lifecycle, or fallback engine. ACP conformance is mandatory product
behaviour, not an opt-in runner mode.
