---
"@reddb-io/red-skills": patch
---

The opencode-host passthrough follows the dev adapter's rename to `rs_dev`

#4023 renamed the dev plugin's MCP server from `redskilled` to `rs_dev` (ADR
0147 §2) but left `apps/opencode-host` asserting the old name, so `main` went red
on `test-packages` and every open PR inherited the failure. The assertions are
repointed at the new server name; the launcher script keeps its own name, because
only the server moved.
