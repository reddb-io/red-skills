---
name: init
description: One-time setup wizard for the memory plugin. Asks what storage to use and writes the per-project memory config. Two modes ship today — markdown-only (plain notes, no engine) and graph (a typed knowledge graph over a per-project RedDB store). Hooks and MCP stay off in both. Use when the user installs the memory plugin and wants to turn memory on, or says "memory init", "set up memory", "initialize memory".
---

# memory init

Bootstraps the `memory` plugin for the current repo. Pick a storage mode:

- **markdown-only** — persistent, queryable memory with **zero engine
  dependency**: notes are plain markdown under `.red/memory/notes/`, no hooks
  fire, no MCP server runs, RedDB is not required.
- **graph** — a typed knowledge graph (nodes + edges) over a per-project RedDB
  store at `.red/memory/graph.rdb`. `/memory:store` writes nodes (deduped by
  content); `/memory:recall` scans and expands the graph. RedDB is required, but
  it runs out-of-process from the bundled binary — no service to manage. Graph
  mode can also opt into the four **auto-firing hooks** (SessionStart recall,
  PostToolUse re-index, Stop extract, PreCompact flush); they default off.

Hybrid mode arrives in a later release. markdown-only never gets hooks. MCP
stays off in both modes this slice.

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

Run from the repo you want memory in (`--root` defaults to the current dir).
Pass the mode the user picked:

```bash
# markdown-only — no engine, nothing auto-fires
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init --mode markdown-only

# graph — typed knowledge graph over a per-project RedDB store
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init --mode graph

# graph with the four auto-firing hooks on (recall/index/extract/flush)
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" init --mode graph --hooks
```

markdown-only writes `.red/memory/config.json` (all hooks off, MCP off, RedDB
not required) and creates `.red/memory/notes/`. graph writes the same config
shape with `mode: "graph"`, `reddb: true`, a `storePath`, and provisions the
RedDB store at `.red/memory/graph.rdb` (graph mode needs step 1's build to have
run — the SDK and its bundled binary come from `node_modules/`).

Ask the user whether to turn the auto-firing hooks on. Pass `--hooks` only in
graph mode and only if they say yes; the hooks are wired in the plugin manifest
but stay **dormant** (the CLI reads the config and exits silently) until the
config flag is on. On **Codex**, also tell the user to set
`[features].plugin_hooks = true` in their config — Codex hooks are off by
default, and note that Codex has no `PreCompact` event (the flush leans on Stop
+ SessionStart there).

## 3. Confirm

Tell the user memory is on, which mode, whether the auto-firing hooks are on or
off (MCP stays off), and that they can now use `/memory:store <fact>` and
`/memory:recall <query>` — which route to the configured mode automatically.

## DOs / DON'Ts

- ✅ Build the CLI before running it if `dist/` is absent (graph mode needs `@reddb-io/sdk` installed).
- ✅ Keep hooks off in markdown-only mode — `--hooks` only applies to graph mode; the resolver forces them off otherwise.
- ✅ Ask before passing `--hooks`; the config flag, not the manifest, is what makes a hook active vs dormant.
- ❌ Don't require, install, or connect to RedDB in markdown-only mode.
- ❌ Don't commit `.red/memory/graph.rdb*` — the store is per-project local state, like `node_modules/`.
- ❌ Don't hand-write `.red/memory/config.json` — go through the CLI so the schema stays valid.

</what-to-do>

<supporting-info>

## Config shape

markdown-only:

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

graph:

```json
{
  "version": 1,
  "mode": "graph",
  "notesDir": ".red/memory/notes",
  "storePath": ".red/memory/graph.rdb",
  "hooks": { "sessionStart": false, "postToolUse": false, "stop": false, "preCompact": false },
  "mcp": false,
  "reddb": true
}
```

## Graph storage internals

Graph writes go through RedDB's multi-model DML (`INSERT … NODE/EDGE`), not
table inserts, and dedupe lives in a KV index — see ADR 0007 for the engine
constraints. The store is the embedded `file://` RedDB; the SDK spawns the
bundled `red` binary out-of-process, so there is no service to run.

## Scope of this slice

Builds on the markdown-only tracer (PRD #49, #51) by adding graph mode: the
core `MemoryStore` over RedDB (node/edge write + dedupe + supersede), the
`memory init --mode graph` build/provision path, mode-routed `/memory:store` /
`/memory:recall`, and the four init-gated **auto-firing hooks** (SessionStart
recall, PostToolUse re-index, Stop extract, PreCompact flush) wired for both
Claude Code and Codex. Not yet included (later slices): hybrid storage, the MCP
server enablement at init, and the `/afk`, `/triage`, `/diagnose` integrations.

</supporting-info>
