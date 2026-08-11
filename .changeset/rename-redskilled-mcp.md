---
"@reddb-io/dev": patch
"@reddb-io/red-skills": patch
---

Rename the dev plugin's complete MCP from `castle` to `redskilled`. The launcher,
bundle, npm bin, prompt namespace, resource URI, host-prefixed tool examples,
and every published skill now use the same name. Codex and Claude share one
version-pinned `npx` delivery path; `red-castle` state and internal contracts keep
their existing names.
