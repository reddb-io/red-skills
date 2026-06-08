---
name: capture
description: Save durable knowledge into the project Brain.
---

# Capture Skill

Use this when the user asks to save, dump, remember, or capture something in the
project Brain. Brain stores typed artifacts in the workspace `.red/brain/*`
RedDB store.

Use Brain, not Memory, for Personal facts: biographical details, identity
context, durable human preferences, relationship notes, and other human-facing
context the user wants available later.

Call the `brain_capture` MCP tool when available. Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" capture --title "<title>" --kind note "<content>"
```

Do not capture secrets, raw credentials, API keys, or passwords.
