---
name: init
working-mode: interactive
description: One-time setup wizard for the memory plugin. Asks what storage to use and writes the per-project memory config. Two modes ship today — markdown-only (plain notes, no engine) and graph (governed operational memory over a per-project RedDB store). Hooks are optional in graph mode; MCP/read surfaces come with graph mode. Use when the user installs the memory plugin and wants to turn memory on, or says "memory init", "set up memory", "initialize memory".
disable-model-invocation: true
---

# memory init

<what-to-do>

**Bootstrap memory for this repo: pick the storage mode with the user, run the wizard, and confirm which mode and hooks are active before pointing them at the next step.**

## 1. Runtime is fetched automatically (no build step)

`${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs` ships with the plugin and resolves
the runtime on first use — it downloads the bundled CLI (`memory-cli.mjs`) plus
the native `red` engine into `~/.cache/reddb-memory/<version>/` and verifies
their checksums (ADR 0029). There is nothing to build or `pnpm install`; the
first command below just pays a one-time download (needs network). Every command
in these skills runs through the bootstrap, which delegates to the fetched CLI.

## 2. Run the wizard

Run from the repo you want memory in (`--root` defaults to the current dir).
Pass the mode the user picked:

```bash
# markdown-only — no engine, nothing auto-fires
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" init --mode markdown-only

# graph — typed knowledge graph over a per-project RedDB store
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" init --mode graph

# graph with the four auto-firing hooks on (recall/index/extract/flush)
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" init --mode graph --hooks
```

markdown-only writes a `plugins.memory` block to `.red/config.yaml` (all hooks off, MCP off, RedDB
not required) and creates `.red/memory/notes/`. graph writes the same config
shape with `mode: "graph"`, `reddb: true`, a `storePath`, and provisions the
RedDB store at `.red/memory/graph.rdb`.

If graph mode was chosen, read [graph-reference.md](graph-reference.md) for the
written config shape and how graph writes are stored.

Ask the user whether to turn the auto-firing hooks on. Pass `--hooks` only in
graph mode and only if they say yes; the hooks are wired in the plugin manifest
but stay **dormant** (the CLI reads the config and exits silently) until the
config flag is on. On **Codex**, also tell the user to set
`[features].plugin_hooks = true` in their config — Codex hooks are off by
default, and note that Codex has no `PreCompact` event (the flush leans on Stop
+ SessionStart there).

## 3. Confirm

Tell the user memory is on, which mode, whether the auto-firing hooks are on or
off, and that they can now use `/memory:store <fact>` and
`/memory:recall <query>` — which route to the configured mode automatically.
For graph mode, mention the golden path: store one scoped decision/gotcha,
recall it, verify with claim-check/readiness/governance, then hand off with a
context pack when needed.

## DOs / DON'Ts

- ✅ Ask before passing `--hooks`; the config flag, not the manifest, is what makes a hook active vs dormant.
- ❌ Don't require, install, or connect to RedDB in markdown-only mode.
- ❌ Don't commit `.red/memory/graph.rdb*` — the store is per-project local state, like `node_modules/`.
- ❌ Don't hand-write the `plugins.memory` block in `.red/config.yaml` — go through the CLI so the schema stays valid.

</what-to-do>

<supporting-info>

## Storage modes

- **markdown-only** — searchable project notes with **zero engine dependency**:
  notes are plain markdown under `.red/memory/notes/`, no hooks fire, no MCP
  server runs, RedDB is not required.
- **graph** — governed operational memory (nodes + edges) over a per-project
  RedDB store at `.red/memory/graph.rdb`. `/memory:store` writes deduped facts;
  `/memory:recall` returns zero-token governed context with graph expansion,
  provenance/trust, and supersession handling. RedDB is required, but it runs
  out-of-process from the bundled binary — no service to manage. Graph mode can
  also opt into **auto-firing hooks** (SessionStart recall, PostToolUse re-index,
  Stop extract, PreCompact flush where the host supports it); they default off.

Hybrid mode is not a separate storage mode: use markdown-only for plain notes or
graph for governed operational memory. markdown-only never gets hooks. MCP/read
surfaces are available from the fetched CLI; hook activation still comes from the
per-project config.

## Plugin dependency

The `memory` plugin requires the `dev` plugin (it builds on dev's processes —
`/afk`, `/triage`, `/diagnose`). Install `dev` first.

</supporting-info>
