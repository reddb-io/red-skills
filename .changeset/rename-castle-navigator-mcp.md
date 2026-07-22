---
"@reddb-io/dev": patch
"@reddb-io/code-nav-mcp": patch
"@reddb-io/red-skills": patch
---

Rename the dev plugin's MCP servers to colon-free names: `dev:afk` → `castle` and
`code-nav` → `navigator`. Codex rejects `:` in MCP server names, which broke every
`dev:*` form. The AFK launcher is now `plugins/dev/hooks/castle-mcp.sh`, the bundle
is `castle-mcp.bundle.min.mjs`, and the npm bin is `red-skills-castle-mcp`. Pure
rename, zero behavior change; takes effect on the next plugin update.
