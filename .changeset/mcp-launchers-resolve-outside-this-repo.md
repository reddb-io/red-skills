---
"@reddb-io/dev": patch
---

Give the castle and rsp MCP launchers a candidate that resolves outside this repo

An MCP server is declared once and started from EVERY directory the operator
works in — which is almost never this repo. `plugins/dev/.mcp.json` shipped three
servers with three different resolution strategies: `navigator` carried the
installed-marketplace fallback and worked, while `castle` and `rsp`, declared
three lines away, resolved only through `$CODEX_PLUGIN_ROOT` and `$PWD`.

Outside the repo both are wrong — the env var is unset and `$PWD` is the
operator's own project — so the launcher was never found and the host reported a
transport failure rather than a missing file:

```
MCP client for `castle` failed to start: Broken pipe (os error 32),
when send initialize request
MCP client for `rsp` failed to start: connection closed: initialize response
```

Both now carry the same `$HOME`-anchored candidate `navigator` already had. A
guard (`apps/dev/tests/mcp-launcher-reachability.test.ts`) fails any file-resolving
launcher without one, and separately pins the dev plugin's three servers to the
same contract — siblings in one file with nothing comparing them is how this
shipped.
