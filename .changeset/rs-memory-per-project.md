---
"@reddb-io/red-skills": minor
---

`rs_memory` is a thin adapter, and memory belongs to the Project

ADR 0152 moves the memory store off the checkout: the default root is
`~/.red/memory/<project-id>`, keyed by the Project's GitHub identity so it
survives a clone, a move and a rename, and the daemon holds one handle per
Project per host. A repository may still opt in to `./.red/memory` through
`plugins.memory.store: checkout` — an operator who wants their notes committable
is entitled to that — but the daemon opens that store only for the interactive
and ADR-editing Working modes. A caller exporting `RED_MODE` is a Worker, and a
Worker never reaches the human's checkout.

The MCP server is renamed `red-memory` → `rs_memory`, matching `rs_dev` and
`rs_brain`. ADR 0005 is amended rather than superseded: its positioning stands,
and only the noun behind "repo" changed.
