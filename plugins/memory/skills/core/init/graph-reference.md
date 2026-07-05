# Graph-mode reference

Read this only when graph mode was chosen — the config shape written for the
`plugins.memory` block and how graph writes are stored.

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
