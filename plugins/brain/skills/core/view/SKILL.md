---
name: view
working-mode: interactive
description: Open the project Brain graph in red-ui (cluster/query/collections/home) by pointing the red-ui MCP App at the local brain.rdb store, with a browser fallback for terminal hosts. Use when the user wants to visually explore Brain artifacts and typed connections.
---

# brain view

Opens the project's Brain store (`.red/brain/brain.rdb` by default) as a visual
red-ui workspace. The viewer is read-only from the skill's point of view: it
points red-ui at the RedDB store and never writes, seeds, or mutates Brain data.

<what-to-do>

**Resolve the Brain store, pick a red-ui view, then open it host-aware: embedded
red-ui MCP App when available, browser red-ui fallback in terminal hosts.**

### 1. Resolve the Brain store

- Default connection string: `file://./.red/brain/brain.rdb` (repo-relative).
- If `.red/brain/config.yaml` exists and sets `connection_string:`, use that
  value instead. Support `$VAR` and `${VAR}` references from the process
  environment or the workspace root `.env`, matching the Brain CLI config
  contract.
- `file://` connections must resolve to an absolute filesystem path before
  opening red-ui.
- HTTP/remote connection strings may be passed through as-is.
- If the resolved `file://` path does not exist, tell the user Brain has no
  store to view yet, point them at `brain init` and `brain capture`, and stop.
  Do not invent a connection or create a store just to view it.

### 2. Pick the view

Map the user's intent to red-ui's view enum (default `cluster`):

- graph / clusters / communities / connections / edges -> `cluster`
- query / search / cypher / SQL -> `query`
- collections / tables / records -> `collections`
- home / overview -> `home`

### 3. Open it - host-aware

- **GUI / MCP-Apps host** (Claude Desktop, claude.ai, VS Code, Cursor, etc.):
  call the red-ui MCP tool **`open_red_ui`** with:

  ```json
  { "connectionUrl": "<absolute .rdb path or HTTP URL>", "view": "<view>" }
  ```

  Use the absolute path without a `file://` prefix for local files. red-ui can
  spawn a local RedDB server for that file and render Brain graph collections in
  the embedded app.

- **Terminal host**, or red-ui unavailable / not rendered: MCP Apps need an
  iframe-capable host. Start a read-only loopback RedDB HTTP server and give the
  user the browser red-ui URL path to use:

  ```bash
  red server --http --http-bind 127.0.0.1:5055 --path <absolute-brain.rdb> --read-only --no-create-if-missing
  ```

  Then tell the user to open `https://ui.reddb.io` and connect to
  `http://127.0.0.1:5055`, selecting the same red-ui view. If port `5055` is
  busy, choose another loopback port. State clearly that this is the browser
  fallback because the current host cannot render the embedded MCP App.

### What the graph should show

- Brain artifacts live in `brain_artifacts` as graph nodes. Node labels are the
  artifact ids; node types are artifact kinds such as `decision`, `concept`,
  `question`, `note`, and `source`.
- Brain connections live in `brain_connections` as graph edges. Edge labels are
  typed connection kinds such as `supports`, `contradicts`, `depends_on`,
  `derived_from`, `related_to`, `part_of`, `preceded_by`, `followed_by`,
  `authored`, and `tagged`.
- The `cluster` view is the default because it is the graph/connection explorer.
  Use `collections` or `query` when the user asks to inspect raw tables or run
  RedDB queries.

### Hard rules

- Do not write to or mutate the store.
- Do not create a missing `brain.rdb` just to open a viewer.
- Do not put secrets or tokens in `connectionUrl`, browser URLs, or iframe URLs.
- Default to `cluster` when the user simply asks to view Brain.
- Always say which surface opened: embedded red-ui MCP App or browser fallback.

</what-to-do>

<supporting-info>

### connectionUrl forms

- Local file: pass the absolute `.rdb` path to `open_red_ui`, for example
  `/repo/.red/brain/brain.rdb`.
- HTTP server: pass a local RedDB HTTP endpoint such as `http://127.0.0.1:5055`.

### red-ui views

`home`, `query`, `collections`, `cluster`, `security`. This skill uses
`cluster` by default and limits user-facing choices to
`cluster/query/collections/home`.

</supporting-info>
