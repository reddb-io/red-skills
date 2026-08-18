# 0147 — One binary, and thin Plugin MCPs that multiply per session

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0123 (MCP-first, CLI fallback — amended), ADR 0126 (rsp resident — suspended surface), ADR 0142 (`redskilled` public name), ADR 0144 (host control plane), ADR 0145 (ACP fabric — amended §1), ADR 0146 (one package per plugin)
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

The `dev` runtime ships `red-skills-dev`, a 36-command CLI (`dist/dev.bundle.min.mjs`)
that duplicates the 45 MCP tools as operator verbs *and* is the body the daemon
spawns for an AFK Worker. Every castle-verb skill names the MCP tool first and
the CLI as fallback (ADR 0123 rule 1), so both surfaces are tested, bundled,
released and documented; on one developer machine three versions of them
coexisted (3.17.1 in the host plugin cache, 3.18.12 in the npx cache, 3.19.3 on
`main`) with two retired `__castle-resident` processes still alive. Alongside the
daemon, each session also woke the `rsp` resident, a `navigator` (code-nav) server
and, for memory/brain, the third-party `red-ui` MCP — one heavy process per
plugin per session, and Workers inherited the same set.

## Decision

1. **`redskilled` is the only shipped binary of the execution chain.** Its argv
   births, provisions, stops, and answers `--version`/`--help`; it may serve
   *reads* the host hooks need at prompt cadence (`statusline`, `dashboard`,
   `host-state`); it carries **no workflow verb**. `red-skills-dev` and its 36
   commands are deleted, not deprecated: a command some skill still names becomes
   a tool of the plugin's MCP; a command no skill names dies with the bundle.
2. **A plugin ships one Plugin MCP** named `rs_<plugin>` (`rs_dev`, `rs_memory`,
   `rs_brain`) plus the cross-plugin `rs_github`: thin, stateless ACP clients of
   the daemon that publish tool schemas and forward calls. They own no engine,
   store, GitHub client, or fallback, so a host may start one per session without
   paying for a resident.
3. **A Worker's inner coding agent mounts no MCP.** Its channels are the ACP
   client the Worker provides — filesystem, terminal, permission — and nothing
   else; deterministic operations (publish, PR, land, memory) are requested by the
   Worker from its parent over ACP after the turn. Memory may reach the inner
   agent later through the same parent, never as a mounted server.
4. **`rsp` and `navigator` are switched off** — MCP entries, hooks (`prime`,
   `pre-exec`, `post-exec`) and the session-start `rsp-instructions` injection
   removed, code kept — until their residents fold into the daemon (rsp) or the
   daemon has a memory ceiling of its own (navigator). `red-ui` leaves the
   default `.mcp.json` of memory and brain and becomes an opt-in in
   `.red/config.yaml`.

## Considered options

- Keep MCP-first with the CLI as documented fallback (ADR 0123). Rejected: a
  fallback is a second implementation that ages at its own pace, and the
  version skew above is what two implementations look like on one machine.
- Keep a thin `redskilled` client CLI for humans and scripts (status, drain,
  stop). Rejected: it becomes the fallback again within a month; reads that a
  hook needs at prompt cadence are the one exception, and they are reads.
- Name the adapters `redskilled`/`memory`/`brain`. Rejected in favour of a
  visible `rs_` prefix that survives hosts that do not namespace by plugin.

## Consequences

- ADR 0123 rule 1 and ADR 0145 §1 are amended: MCP is the sole client surface;
  "CLI" survives only as the daemon's process-lifecycle argv.
- The `Token-efficient terminal work` section of `CLAUDE.md` leaves with the
  rsp hooks; the code under `apps/rsp` stays for the fold-in.
- Skills that spell `npx -y -p @reddb-io/red-skills@<v> red-skills-dev …` are
  rewritten to name the `rs_dev` tool; the bare-invocation guard keeps
  `redskilled` as the only binary a doc may instruct.
