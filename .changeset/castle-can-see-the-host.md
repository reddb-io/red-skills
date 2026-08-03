---
"@reddb-io/red-skills": minor
---

The castle MCP can now inspect the host-scoped `redskilled` daemon without
leaving its tool surface. Four read-only tools expose the machine-wide state,
global dashboard, provisioning health check, and optional supervisor-unit
status. Host mutations remain operator-only: castle exposes neither provisioning
nor reclaim, and the daemon wire protocol gains no command.
