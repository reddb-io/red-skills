---
"@reddb-io/red-skills": major
---

`apps/<kind>-<name>`: the directory says what the thing is

ADR 0153. `apps/` mixed runtimes named for a plugin, for a capability, for a host,
for a Worker image and for benchmarks, so a reader could not tell kind from name.
The renames: `dev` → `plugin-dev`, `memory` → `plugin-memory`, `brain` →
`plugin-brain`, `code-nav` → `mcp-navigator`, `red-browser` → `mcp-browser`,
`afk-container` → `worker-container`, `zellij-plugin-dashboard` →
`zellij-plugin-redskilled`, `vscode-extension-red-skills` →
`vscode-extension-redskilled`, `herdr-plugin-red-skills` →
`herdr-plugin-redskilled`, `opencode-host` → `host-opencode`. Benchmarks leave
`apps/` for `benchmarks/<name>`, which gains its own workspace glob.

`redskilled`, `rsp` and `release` keep their names — they are already what they
are — and `plugins/<name>` stays bare, because that is what a host installs.
