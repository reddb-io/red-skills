---
"@reddb-io/red-skills": patch
---

Shipped-hook interpreter contract (#2626, Spec #2466): one strategy across every shipped hook — a hook is a bash script and every invocation site names bash explicitly, while the host `sh -c` wrappers stay strictly POSIX because `/bin/sh` is dash on Debian/Ubuntu. The `.mcp.json` launchers now `exec bash "$launcher"` instead of `exec sh`, the remaining `#!/bin/sh` hooks declare bash, the hook dispatcher survives a hook that ignores stdin instead of dying on EPIPE, and a new suite runs every shipped hook in a sandbox whose `sh` is dash while linting each wrapper body for bashisms.
