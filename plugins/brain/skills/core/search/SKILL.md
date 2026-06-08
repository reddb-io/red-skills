---
name: search
description: Search artifacts in the project Brain.
---

# Search Skill

Use this before answering questions that depend on the workspace's captured
knowledge, prior decisions, open questions, plans, or references.

Call `brain_search` when MCP is available. Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" search "<query>"
```

Use each hit's `score_breakdown` to explain relevance when needed. The current
signals are lexical matches, tags, artifact kind, graph connections, and a
reserved vector slot.
