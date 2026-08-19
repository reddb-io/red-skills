---
"@reddb-io/red-skills": patch
---

The focused ACP conformance script runs on Windows

`test:acp-agent-conformance` shipped with a POSIX-only `NODE_OPTIONS=... vitest`
prefix, which `cmd` reads as a command name — the Windows CI leg failed with
`'NODE_OPTIONS' is not recognized`, taking the aggregate `test` gate red on
`main`. It now matches its Windows-proven sibling `test:acp-local-transport` and
carries no prefix; the suite is 22 fast tests and never needed the heap bump.
