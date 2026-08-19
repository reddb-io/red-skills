---
name: status
working-mode: interactive
description: Report the project Brain store's health — whether Brain initialized in this workspace, the resolved connection string, and how many artifacts and connections are stored. Use when the user says "brain status", "is brain set up", "check brain", or wants to confirm Brain is live before capturing or searching.
disable-model-invocation: true
---

# brain status

Reports the operational health of the project Brain store (`.red/brain/brain.rdb`): whether Brain initialized in the current workspace, the resolved connection string, and the count of stored artifacts and connections. Read-only — it inspects, never mutates.

<what-to-do>

**Run the status check, then report initialization state, the connection string, and the artifact/connection counts.**

Call the `brain_status` MCP tool when available. Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" status
```

If Brain is not initialized, tell the user to run `brain init` first.

</what-to-do>
