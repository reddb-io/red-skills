---
"@reddb-io/red-skills": patch
---

The install-metadata validator follows the dev adapter's rename to `rs_dev`

#4023 renamed the dev plugin's MCP server `redskilled` → `rs_dev` (ADR 0147 §2)
and left `validate-install-metadata.sh` asserting the old key, so `main` is red on
`validate-marketplace` and every open PR inherits it — the same shape as #4059,
one key later. The launcher keeps its own filename because only the server moved.
