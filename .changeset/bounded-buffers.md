---
"@reddb-io/shared": patch
"@reddb-io/protocol-acp": patch
"@reddb-io/redskilled": patch
---

Every wire buffer has a ceiling, and the resident client sheds its update tail: an unterminated frame past `MAX_WIRE_FRAME_BYTES` (8 MiB) refuses the connection loudly on both the op-socket server and the dual-dialect ACP stream (nothing to resync on past the ceiling — skip-and-log covers only frames WITH a terminator), and the project ACP client's `pendingUpdates` array — which retained the agent's whole output stream for the connection's life, MB/hour in a long-lived MCP resident — is capped at the newest 512 with shed-count bookkeeping so each prompt still slices exactly its own tail. Leak-audit findings: frame buffers + resident client.
