---
"@reddb-io/red-skills": patch
---

OpenCode/RedCode MCP entries (navigator, redskilled, rsp) now resolve against the tree the install generates from — the materialised package set or the checkout — instead of a Codex marketplace cache that happened to exist; the rsp launcher chain names the package set's `bin/rsp.mjs`.
