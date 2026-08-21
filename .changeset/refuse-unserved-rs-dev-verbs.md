---
"@reddb-io/dev": patch
---

`rs_dev` refuses an unserved tool by name instead of prompting a Worker (#4113).

Four of the 55 published tools reached a real ACP control call; the other 51 fell
through to `session.prompt("/<tool> {…}")`, which a Worker with no ticket handoff
narrated and ended, returning a healthy-looking empty envelope. The routing is now
declared once in `apps/plugin-dev/src/core/mcp-tool-routing.ts` — control, served,
or unserved-with-a-reason — pinned on every gate run against both the live tool
registry and the live `_redskills/*` method list, with the unserved list
shrink-only.
