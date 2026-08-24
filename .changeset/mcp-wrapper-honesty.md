---
"@reddb-io/dev": patch
---

The danger posture now guards the path that runs: the stdio MCP adapter rebuilds the tool surface with the ACP invoke as each tool's body and wraps THAT with `applyDangerPosture("confirm")`, so a MUTATING tool (`gate_run`, `land_branch`) refuses without `confirmation: true` and the published schema carries the `confirmation` argument. The gate previously wrapped tool bodies the adapter never executed.
