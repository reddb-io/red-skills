---
"@reddb-io/red-skills": patch
---

Restage the Pi copy of the dev plugin's MCP launcher

The source launcher gained argument forwarding (`"$@"`) and the staged Pi mirror
was not rebuilt with it, so `build-pi-packages --check` failed on `main` and every
open PR inherited the red typecheck job. Generated artifact only — no behaviour
change beyond the mirror matching its source.
