---
"@reddb-io/redskilled": patch
---

The rs_dev MCP survives a daemon restart. The Project ACP client held one
connection for its whole life, so every release install turned every later
tool call into "ACP connection closed" until the operator restarted the MCP
process. The session now rides a self-healing dial: a dead connection is
re-dialled single-flight before answering the call, and only a genuinely
unreachable daemon surfaces, with the provision repair the dial carries.
