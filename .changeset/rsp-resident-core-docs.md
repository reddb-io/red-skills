---
"@reddb-io/red-skills": patch
---

The rsp documentation surfaces now describe the resident as the core (#2689, ADR 0126). The generated ambient host instructions gained a `Core model` section stating that the CLI, the wrappers, the pre-exec hook, the proxy and the MCP server are peer clients of one resident behind a unix socket with no privileged contact point among them, and that a host with no MCP server connected is fully supported. `docs/TROUBLESHOOTING.md` leads with a resident-first diagnosis path that separates a resident which never started (auto-spawn blocked, no socket) from a stale socket whose process is gone, and tabulates the exact observable fail-open behaviour per surface: wrappers and the proxy hand back the raw result, the hook passes the command through unrewritten, `stats` and the bare dashboard degrade to the empty snapshot, `wait` keeps its spooled bytes, and the MCP tools return the payload they were handed.
