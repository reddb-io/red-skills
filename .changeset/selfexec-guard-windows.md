---
"@reddb-io/shared": patch
"@reddb-io/dev": patch
---

The red-fetch self-exec guard matches on Windows. The direct-invocation check
compared `import.meta.url` to a raw `file://${argv[1]}`, which never equals a
backslash path, so the SessionStart pre-warm silently exited without running
on every Windows host. The comparison now goes through `pathToFileURL`.
