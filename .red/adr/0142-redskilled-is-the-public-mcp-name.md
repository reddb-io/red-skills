# 0142 — `redskilled` is the public MCP name; castle remains the substrate

- **Status**: accepted
- **Date**: 2026-08-11
- **Related**: ADR 0120 (complete project MCP), ADR 0123 (MCP-first clients), ADR 0130 (`redskilled` host service), ADR 0134 (one situational front door)

## Context

The dev plugin still registered its complete execution MCP as `castle`. That
name came from the `red-castle` package that originally owned most of the tool
implementations. ADR 0130 then made `redskilled` the operator-facing service for
host reach, project registration, Worker birth, limits, and placement. An agent
now had to translate between a `redskilled` service, a `/redskilled` operations
skill, and a differently named `castle` MCP before it could call the interface
that joins those capabilities.

The MCP is not a transparent daemon proxy. It also exposes project-local queue,
GitHub, gate, landing, claim, Worktree, and red-castle state operations. Naming
the public boundary after `redskilled` therefore identifies the system an
operator talks to; it does not move project semantics into the host daemon or
rename the substrate.

Codex and Claude must also reach the same published artifact. A host-specific
download path would make the server name converge while its delivery diverged.

## Decision

**The dev plugin registers the complete project MCP as `redskilled`.** Its host
tool prefix is derived from that name, its prompt namespace is `redskilled:*`,
and its subscribable lane resource uses `redskilled://`.

The shipped delivery surface follows the same name:

- launcher: `plugins/dev/hooks/redskilled-mcp.sh`;
- bundle: `redskilled-mcp.bundle.min.mjs`;
- npm bin: `red-skills-redskilled-mcp`.

Installed Codex and Claude sessions execute that bin through the same canonical
version-pinned command:

```text
npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled-mcp
```

Neither host owns a binary download mechanism. The launcher may execute a local
bundle only from an identifiable source checkout, as a development fallback.

`red-castle`, `.red/state/castle/`, `red.castle.*` wire contracts, and internal
`Castle*` TypeScript names remain unchanged. They name the execution substrate,
durable project state, and existing contracts rather than the installed MCP
server. No duplicate `castle` server alias is registered: two copies of the
complete tool surface would double the resident process and make discovery
ambiguous. A plugin reload or a new session applies the rename.

Every published skill and agent-read reference calls the server `redskilled`.
A documentation ratchet scans the whole skill tree so a backward route to the
old MCP name fails CI.

## Consequences

- Host-prefixed tools change from `mcp__plugin_dev_castle__<tool>` to
  `mcp__plugin_dev_redskilled__<tool>`.
- Prompts change from `castle:<intent>` to `redskilled:<intent>`.
- ADRs 0120, 0123, and 0134 keep their capability and choreography decisions;
  this record amends their public-name examples.
- `redskilled` names both the host service and its complete project-facing MCP,
  while `red-castle` remains visible only where substrate or state ownership is
  the fact being described.

## Amendment — 2026-08-19 (ADR 0147 rule 2, issue #4023)

Superseded on the MCP name alone. The dev plugin's MCP is now `rs_dev`: one
Plugin MCP per plugin, named `rs_<plugin>`, so a host that does not namespace a
server by its plugin still shows which plugin published a tool. `redskilled`
keeps everything else this record decided — it is the daemon, the binary and the
host service; it is no longer the name of a server a session mounts.

- Host-prefixed tools are `mcp__plugin_dev_rs_dev__<tool>`.
- Prompts are `rs_dev:<intent>`.
