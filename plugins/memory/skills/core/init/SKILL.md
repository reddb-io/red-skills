---
name: init
description: One-time setup wizard for the memory plugin. Asks what storage to use and writes the per-project memory config. This build ships the markdown-only path — memory backed by plain markdown notes, with hooks and MCP off and no RedDB required. Use when the user installs the memory plugin and wants to turn memory on, or says "memory init", "set up memory", "initialize memory".
---

# memory init

Bootstraps the `memory` plugin for the current repo. Markdown-only mode gives
the agent a persistent, queryable memory with **zero engine dependency**: notes
are plain markdown under `.red/memory/notes/`, no hooks fire, no MCP server runs,
and RedDB is not required. Graph and hybrid modes arrive in later releases.

The `memory` plugin requires the `dev` plugin (it builds on dev's processes —
`/afk`, `/triage`, `/diagnose`). Install `dev` first.

<what-to-do>

## 1. Build the CLI if needed (first run only)

The plugin ships **source only** — `dist/` and `node_modules/` are gitignored and
built on the user's machine. If `${CLAUDE_PLUGIN_ROOT}/dist/cli.js` does not
exist, build it (needs only node + pnpm, nothing else):

```bash
pnpm --dir "${CLAUDE_PLUGIN_ROOT}" install
pnpm --dir "${CLAUDE_PLUGIN_ROOT}" build
```

## 2. Run the wizard

Run from the repo you want memory in (`--root` defaults to the current dir):

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init --mode markdown-only
```

This writes `.red/memory/config.json` (mode `markdown-only`, all hooks off, MCP
off, RedDB not required) and creates `.red/memory/notes/`.

## 3. Confirm

Tell the user memory is on in markdown-only mode, that nothing auto-fires, and
that they can now use `/memory:store <fact>` and `/memory:recall <query>`.

## DOs / DON'Ts

- ✅ Build the CLI before running it if `dist/` is absent.
- ✅ Keep markdown-only mode hooks-off — do not wire any SessionStart/Stop/PreCompact hook in this mode.
- ❌ Don't require, install, or connect to RedDB in markdown-only mode.
- ❌ Don't hand-write `.red/memory/config.json` — go through the CLI so the schema stays valid.

</what-to-do>

<supporting-info>

## Config shape

```json
{
  "version": 1,
  "mode": "markdown-only",
  "notesDir": ".red/memory/notes",
  "hooks": { "sessionStart": false, "postToolUse": false, "stop": false, "preCompact": false },
  "mcp": false,
  "reddb": false
}
```

## Scope of this slice

First end-to-end slice of PRD #49. Ships the markdown-only path of the init
wizard plus `/memory:store` and `/memory:recall`. Not yet included (later
slices): graph and hybrid storage over RedDB, the MCP server, the auto-firing
hooks (SessionStart recall, PostToolUse index, Stop extract, PreCompact flush),
and the `/afk`, `/triage`, `/diagnose` integrations.

</supporting-info>
