# 0120 — red-castle is the AFK MCP; CLI and skills are clients

- **Status**: accepted
- **Date**: 2026-07-21
- **Related**: ADR 0113 (castle owns the truth, dev owns the host boundary), ADR 0101 (red-castle as the AFK execution substrate), ADR 0102 (dev as the host-adapter surface), ADR 0091 (npm transport / direct-run), ADR 0081 (`/goal` → `/go` → `/afk` command topology)

## Context

Every interaction with the AFK execution substrate went through the
`red-skills-dev` CLI: launch/stop/status a fleet, dispatch a worker, read
logs/vitals, run the gate, land a branch, requeue, reap. That surface has three
properties that block the direction ADR 0113 set:

1. **Print-and-exit text.** A caller that wants structure must parse rendered
   output, so every consumer re-derives what the engine already knows.
2. **Single supervisor.** The supervisor lane was hardcoded to `default`, so one
   checkout could host exactly one fleet — no partitioning by runner, work
   scope, config, or base.
3. **Shell-only reach.** An agent, a skill, or a future command-center UI could
   only operate the castle by shelling a CLI, which is neither typed nor
   introspectable.

ADR 0113 already put execution truth in castle and the host boundary in dev.
What was missing was the *interface* through which that truth is reached.

## Decision

**red-castle exposes an MCP server, `dev:afk`, and that server is the canonical
complete interface to every castle capability. The CLI, the `/afk` and `/go`
skills, and any future command-center UI are clients of it — no client owns a
capability the MCP lacks.**

Three rules give the principle teeth:

1. **Complete, not fleet-scoped.** The tool surface covers every domain: fleet
   lifecycle, worker dispatch and lifecycle, runners (including live steer), the
   validation gate, landing and cascade, claim, the worktree pool, hygiene
   (requeue / retake / reap / unblock), observability (logs / vitals / dashboard
   / monitor / history), and queue. A capability reachable only by shelling the
   CLI is a gap in the MCP, not a CLI feature.

2. **Every tool wraps a value-returning primitive, never the print-and-exit
   command layer.** CLI handlers and MCP tools share the same cores, so there is
   one source of truth and structured output falls out for free. Tools return
   TOON (ADR 0097), never rendered prose.

3. **Named multi-fleet is a first-class profile.** A fleet is
   `{name, runner, selector, config, base}` — not a worker count — persisted in
   a registry and addressed by name. Several named fleets run concurrently on
   one checkout; the pre-existing three-layer claim (local lock, GitHub label
   pre-check, stale-lock boot sweep) is what keeps two fleets on one backlog
   from double-claiming an issue, so no new mutual exclusion was invented.

**Mutating tools are marked and gated.** A tool that spawns processes, lands
code, costs tokens, or changes issue state carries a `MUTATING:` description
prefix; read tools are free to call. Clients announce a mutating call before
making it.

**The CLI remains a supported fallback, not a parallel implementation.** When a
host cannot reach the MCP, the client names that and falls back to
`red-skills-dev` — the same engine over the same cores, so the fallback changes
transport, not behavior.

## Consequences

- `/afk` and `/go` are rewritten as MCP clients: they name the tool that serves
  each verb and keep the CLI form as the documented fallback. The tool surface
  is documented once, in `plugins/dev/skills/engineering/afk/MCP.md`; the skills
  reference it rather than restating it, and a doc-contract test keeps that file
  in bijection with the server's registered tools.
- A new castle capability is added to the MCP first. Adding it to the CLI alone
  reintroduces the shell-only reach this ADR removes.
- Host tool-name prefixing is the client's problem, not the server's: hosts
  surface plugin MCP tools under an `mcp__…__<tool>` prefix, so clients resolve
  the host identifier once and use bare names in documentation.
- This is the **MCP-first** slice, deliberately: the tools wrap the functions
  where they live today. The full relocation of the engine modules into
  red-castle stays the ongoing #2230 program and is not a precondition here.
- A command-center UI (brain PRD #463) consumes this same surface, which is the
  property that makes the MCP worth being complete rather than convenient.
