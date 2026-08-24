---
"@reddb-io/redskilled-render": patch
---

The global dashboard header answers for the host, and only the host: identity reads `host` instead of the cwd's project, the directory's registration verdict (`!unregistered`/`!lapsed`) stays off the host line, remote counters are no longer borrowed from the cwd's project, and the worker count renders flat (`wrk=N`) instead of the always-1 ratio.
