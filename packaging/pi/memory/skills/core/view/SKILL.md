---
name: view
working-mode: interactive
description: Open the project Memory graph in red-ui (the visual cluster/query/collections workspace) by pointing the red-ui MCP App at the local RedDB store, falling back to the browser Workbench in terminal hosts. Use when the user wants to SEE the memory graph, clusters, or collections visually rather than recall text.
disable-model-invocation: true
---

# memory view

Opens the project's Memory graph store (`.red/memory/graph.rdb`) as a visual workspace. The graph data is served by RedDB; this skill only points a renderer at it — it never mutates the store.

<what-to-do>

**Resolve the store, pick a view, then open it host-aware: the red-ui MCP App in a GUI host, the browser Workbench in a terminal. Read-only — never write to the store, never seed a token in any URL.**

### 1. Resolve the store

- Default store path: `.red/memory/graph.rdb` (repo-relative). If `.red/config.yaml` sets `plugins.memory.storePath`, use that instead. Resolve to an absolute path.
- If the file does not exist, or Memory is in `markdown-only` mode (no graph): tell the user there is no graph to view, point them at `/memory:init` (graph mode) + `/memory:ingest`, and stop. Do not invent a connection.

### 2. Pick the view

Map the user's intent to red-ui's view enum (default `cluster` — the graph):

- graph / clusters / communities → `cluster`
- query / search / cypher → `query`
- collections / tables → `collections`
- home / overview → `home`

### 3. Open it — host-aware

- **GUI / MCP-Apps host** (Claude Desktop, claude.ai, VS Code, Cursor, …): call the red-ui MCP tool **`open_red_ui`** with `{ "connectionUrl": "<abs path to the .rdb store>", "view": "<view>" }`. red-ui spawns a local single-writer `red server` for the file (read-only if the Memory engine already holds it) and renders the workspace embedded in the chat.
- **Terminal host** (Claude Code), or red-ui unavailable / the app does not render: MCP Apps need an iframe surface a terminal does not have. Fall back to the **Workbench** — run `memory serve` to expose the store over `http://localhost:<port>` and give the user the URL to open in a browser (or `memory workbench` for the static artifact). State clearly that you used the fallback and why.

### Hard rules

- ❌ Never write to or mutate the store — this is a read-only viewer.
- ❌ Never put a secret/token in `connectionUrl` or any iframe URL (red-ui seeds only the non-secret endpoint + route; tokens go over the later postMessage channel).
- ❌ Do not invent a connection — if the store is absent, stop and route to `/memory:init` / `/memory:ingest`.
- ✅ Default to `cluster` (the graph) when the user just says "show me the memory graph".
- ✅ Always name which surface opened (embedded MCP App vs browser Workbench fallback).

</what-to-do>

<supporting-info>

### Why host-aware

MCP Apps (SEP-1865) render a server-provided `ui://` HTML resource inside a sandboxed iframe — only GUI hosts have that surface. The red-ui MCP server (wired into this plugin's `.mcp.json` as `red-ui`) advertises `ui://red-ui/app.html`; the graph data itself is read by the red-ui app **directly from RedDB over HTTP**, not through the MCP bridge — the bridge only passes the connection URL and the view. A terminal host (Claude Code) cannot render the iframe, so the Workbench (`memory serve`) is the equivalent surface there.

### connectionUrl forms

- **File path** (e.g. the resolved `.red/memory/graph.rdb`) — red-ui spawns its own `red server` for the file (ADR-0006 single-writer flock; read-only if the Memory engine holds it).
- **HTTP URL** (e.g. `http://localhost:5055`) — if a `red`/`memory serve` process is already serving the store, pass its URL directly.

### red-ui views

`home · query · collections · cluster · security` — `cluster` is the graph/communities visualization.

</supporting-info>
