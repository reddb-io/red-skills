---
"@reddb-io/red-skills": patch
---

`red-skills-dev --help` prints usage and exits 0 (#2581) — it no longer falls through to the run default and boots a live worker drain. Help short-circuits before any routing (bare, `-h`, `help`, and `<command> --help`), and a flag-led invocation whose leading flag is not one of the documented run-surface flags errors with usage instead of silently draining the queue.
