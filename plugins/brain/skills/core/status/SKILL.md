---
name: status
description: Inspect the project Brain store.
---

# Status Skill

Use this to verify that Brain initialized in the current workspace, show the
resolved connection string, and count stored artifacts and connections.

Call `brain_status` when MCP is available. Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" status
```
