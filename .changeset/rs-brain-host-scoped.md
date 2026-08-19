---
"@reddb-io/red-skills": patch
---

Brain is the user's: `rs_brain` names the adapter and the store defaults to `~/.red/brain`

ADR 0152 makes brain host-scoped — a second repository is not a second brain — so
the default root is now `~/.red/brain` and every checkout reaches the same store.
The explicit overrides keep precedence in the order they always had:
`RED_BRAIN_ROOT`, then `plugins.brain.rootDir` in `.red/config.yaml`. A checkout
that ALREADY holds a store keeps using it, because silently pointing an existing
brain at an empty one loses a user's notes.

The plugin's MCP server is renamed `brain` → `rs_brain` per ADR 0147 §2, matching
`rs_dev`.
