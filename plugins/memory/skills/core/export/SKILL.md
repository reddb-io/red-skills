---
name: export
description: Export the memory graph to a self-contained, navigable bundle — graph.json (data), graph.html (an interactive node-link view that opens straight from disk), and audit.md (a health summary). Use when the user says "export memory", "visualize the memory graph", "show me the graph", "dump the memory graph", or wants to browse what's stored. Graph mode only.
---

# memory export

Dumps the whole graph (graph mode only) into a directory as three files:

- **graph.json** — nodes + edges + stats, machine-readable.
- **graph.html** — a single self-contained page (data inlined, no network, no
  build) with a force-directed node-link diagram plus a searchable list. Opens
  straight from disk.
- **audit.md** — a human-readable health summary: counts by node type and edge
  label, superseded chains, orphan nodes, and the most connected nodes.

<what-to-do>

## 1. Require graph mode

`export` needs `.red/memory/config.json` with `mode: "graph"`. If memory is not
initialized or is markdown-only, say so and stop.

## 2. Export

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" export [<out-dir>]
```

`<out-dir>` defaults to `.red/memory/export`. The command prints the three file
paths.

## 3. Point the user at the output

Tell the user where the files are and that `graph.html` opens in any browser
straight from disk (no server needed). Summarize anything notable from
`audit.md` (orphans, superseded chains) if relevant.

## DOs / DON'Ts

- ✅ Open `graph.html` from disk — it is self-contained, no CDN or server.
- ✅ Use `audit.md` to spot orphans / stale structure worth a `/memory:doctor` pass.
- ❌ Don't commit the export bundle — it's a generated snapshot, like `dist/`.

</what-to-do>

<supporting-info>

## MCP

The MCP server's `memory_export` returns the graph as JSON by default; pass
`out_dir` to also write the graph.json + graph.html + audit.md bundle there.

</supporting-info>
