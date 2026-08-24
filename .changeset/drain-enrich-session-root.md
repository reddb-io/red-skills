---
"@reddb-io/dev": patch
---

The rs_dev drain builds its registration from the session's resolved project root instead of the MCP launcher's working directory, and refuses loudly when that root cannot be resolved — a drain without a registration would record intent nothing acts on.
