# OpenCode MCP passthrough — rewrite `mcpServers:` → `mcp:` and resolve plugin roots at build time

## Status

accepted. Refines the Slice 1 + 2 contract (ADR 0075, 0076, 0077) with
the **MCP** surface (Slice 3). The Slice 1 + 2 generator contract is
unchanged; this ADR adds a third output to the dist tree: the per-plugin
`mcp>` block embedded in the Slice 1 `opencode.json`.

## Context

The three RedSkills plugins each ship a `.mcp.json` file under
`plugins/<name>/.mcp.json` that Claude Code and Codex consume
natively:

- `plugins/dev/.mcp.json` — `code-nav` (LSP-backed code navigation
  MCP, launched via `plugins/dev/hooks/code-nav-mcp.sh`).
- `plugins/memory/.mcp.json` — `red-memory` (the operational
  memory CLI's MCP surface, launched via
  `plugins/memory/scripts/bootstrap.mjs mcp`) + `red-ui` (the reddb
  dashboard MCP, launched via `npx @reddb-io/ui`).
- `plugins/brain/.mcp.json` — `brain` (RedDB knowledge repo, launched
  via `plugins/brain/scripts/bootstrap.mjs mcp`) + `red-ui`.

The source `.mcp.json` uses Claude Code's
`mcpServers: { name: { command: "sh", args: ["-c", "..."] } }` shape.
The `sh -c` body resolves the **plugin root** through a chain of
env vars and well-known cache paths:

```sh
root="${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "$root" ]; then
  for candidate in "$PWD/plugins/<plugin>" \
                  "$HOME/.codex/.tmp/marketplaces/red-skills/plugins/<plugin>" \
                  "$HOME/.codex/plugins/cache/red-skills/<plugin>"/*; do
    if [ -f "$candidate/.claude-plugin/plugin.json" ]; then
      root="$candidate"; break
    fi
  done
fi
exec node "$root/scripts/bootstrap.mjs" mcp
```

OpenCode's MCP config has a different shape (verified against the
opencode MCP Servers doc, June 2026):

- Top-level key is `mcp:`, not `mcpServers:`.
- Each entry has `type: "local"` and a **command array** (not a
  string + `args`).
- The plugin root is best passed via `cwd` (an optional field that
  resolves relative to the workspace).
- `${CODEX_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` are **not**
  defined by opencode — the opencode plugin context's `directory`
  is the closest equivalent, but it is the project's CWD, not the
  plugin's source root.

Two practical consequences follow:

1. The Claude/Codex `${CODEX_PLUGIN_ROOT}` chain cannot be reused
   verbatim; the opencode side needs an **absolute plugin root**
   baked into the emitted command, because the only reliable way
   to find the source is to know the install layout (the
   `plugins/<plugin>/scripts/bootstrap.mjs` file lives at a known
   path under the user's repo checkout).
2. The `npx @reddb-io/ui@latest` MCP (`red-ui`) does not need a
   plugin root — it is published as a standalone npm package and
   the opencode command array passes it through verbatim.

## Decision

### 1. The generator emits a `mcp:` block per plugin

For each `plugins/<name>/.mcp.json`, the generator reads the
`mcpServers` map, rewrites each entry into opencode's
`mcp: { <name>: { type: "local", command, environment } }` shape,
and merges the result into the per-plugin `opencode.json` that
Slice 1 already emits. The `command` is an **array** (not a
string) and the `args` of the source `command: "sh"` +
`args: ["-c", "..."]` are flattened into a single command array.

The rewrite is a pure module: `apps/opencode-host/src/mcp-passthrough.ts`
exports `planMcp(pluginsRoot, plugin): McpPlan`. The function
returns a list of `{ name, entry }` triples the emit step merges
into the Slice 1 `opencode.json`. No filesystem IO happens in the
planner.

### 2. The plugin root is resolved at build time, not at runtime

The source `sh -c '... CODEX_PLUGIN_ROOT ...'` chain searches for
the plugin root through four candidate paths. The Slice 3
generator **resolves the same paths at build time** and bakes the
**first existing** candidate into the emitted `command` array.
The runtime search disappears — opencode gets a command that
points directly at the bootstrap script, and the user does not
need a `${CODEX_PLUGIN_ROOT}` env var to be set.

Concretely, the search order is:

1. `<pluginsRoot>/<plugin>/scripts/bootstrap.mjs` (the dev
   checkout — what the local-install path always uses).
2. `<pluginsRoot>/<plugin>/hooks/<name>.sh` (the dev's
   `code-nav-mcp.sh` lives here; the source `for launcher in
   "$root/hooks/code-nav-mcp.sh" ...` block becomes a direct
   reference to the resolved path).
3. The same cache paths the source uses
   (`~/.codex/.tmp/marketplaces/red-skills/plugins/<plugin>`,
   `~/.codex/plugins/cache/red-skills/<plugin>/*`).

The first existing path wins. The build is **fail-closed** when
none exist (the dev checkout does not exist and no Codex cache is
populated): the generator emits a warning naming the missing
script and **skips** the MCP entry. A skill whose MCP is missing
is still emitted (the SKILL.md body is discoverable; the user
sees the missing tool when the LLM tries to call it), and the
install script reports the warning. This is the same
warn-and-continue policy ADR 0077 adopted for unsupported events.

### 3. `${CODEX_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_ROOT}` are rewritten at build time

The source `sh -c` command bodies reference these env vars. The
Slice 3 generator strips the entire `${CODEX_PLUGIN_ROOT:-...}`
fallback chain and replaces it with the resolved **absolute path**
to the script (per point 2). For MCPs that have no plugin-root
dependency (`red-ui` via `npx`), the command array is passed
through verbatim with a `type: "local"` wrapper.

For MCPs that use a single `${CODEX_PLUGIN_ROOT}` reference (the
`code-nav-mcp.sh` in dev), the rewrite is the same shape: the
resolved absolute path replaces the env-var reference, and the
`sh -c` wrapper is removed in favour of Bun's native
`Bun.$\`bash <abs-path>\`` semantics in the emitted
`opencode.json` (opencode consumes the command array directly,
no shell wrapper needed).

### 4. `red-ui`'s `env:` becomes opencode's `environment:`

The source uses `env: { RED_UI_APP_URL: "..." }` (Claude/Codex
shape). OpenCode uses `environment:` (the MCP Servers doc shows
this as the local-server field name). The rewrite is a
key-rename in the planner.

### 5. The `npx -y @reddb-io/ui@latest` MCP is passed through

The `red-ui` MCP is the one entry that does not need a plugin
root. The source is a self-contained npm package; the command
array `["npx", "-y", "@reddb-io/ui@latest", "mcp", "--stdio"]`
is verbatim in the opencode form. The Slice 3 generator passes
it through with a `type: "local"` wrapper and the renamed
`environment:` key.

### 6. `cwd` is set to the plugin source root when available

OpenCode's MCP config supports an optional `cwd` field that
resolves relative to the workspace. The Slice 3 generator sets
`cwd: <pluginsRoot>/<plugin>` when the build is local
(`scripts/install-opencode.sh` runs in the red-skills checkout);
the `cwd` is **omitted** when the build is a release-asset form
(Slice 5, where `cwd` would not point to a real path on the
user's machine). The omission is a no-op — the resolved script
path is already absolute, and opencode's MCP runner spawns the
process without a specific cwd if the field is absent.

### 7. The `mcp-passthrough` module is pure

`apps/opencode-host/src/mcp-passthrough.ts` exports
`planMcp(pluginsRoot, plugin): McpPlan[]` and
`rewriteClaudeToOpencode(pluginsRoot, server): McpEntry`. The
two functions are independently testable; the file-IO happens in
`emit.ts` (the same orchestration as Slice 2). Tests cover
`mcpServers` → `mcp:` renaming, the env-var chain rewrite, the
`sh -c` flattening into a command array, the `env:` →
`environment:` rename, and the missing-script warn-and-continue
case.

## Considered options

- **Reuse the source `sh -c` body verbatim in the opencode
  `command` array** — rejected: opencode's `command` is an
  array of args passed to `spawn` (no shell interpreter), so
  `["sh", "-c", "<long string>"]` would run a shell wrapper
  inside an opencode-spawned shell. The double-shell is hard to
  debug and the search-chain `${CODEX_PLUGIN_ROOT:-...}` cannot
  resolve to a real path on the opencode side. The build-time
  resolution is the cleaner path.
- **Run each MCP under a Bun-embedded shell** (`Bun.$\`sh -c
  <body>\``) — rejected for the same reason the Slice 2 hook
  rewrite worked through inline TS, but MCPs are a different
  shape: they are long-lived processes, not single-shot tool
  invocations. Opencode's `command` array is the native spawn
  surface; routing through Bun's shell is unnecessary indirection
  and would break the standard MCP lifecycle.
- **Emit a per-MCP TS plugin module that re-spawns the bootstrap
  via Bun's `$`** — rejected: the opencode MCP surface is a
  separate protocol from the opencode plugin surface. The plugin
  events (`tool.execute.before`, `tui.toast.show`, etc.) and
  the MCP server protocol are different layers; the simplest
  way to expose a tool to the LLM is `opencode.json`'s `mcp:`
  block, not a plugin module that re-implements MCP by hand.
  The Slice 3 generator keeps the natural MCP shape.
- **Ship the resolved absolute path as a runtime env var the
  bootstrap script reads** — rejected: requires the opencode
  install script to inject an env var, and the source
  `bootstrap.mjs` would need to be modified to read it. The
  existing `bootstrap.mjs` accepts a positional `root` arg or
  falls back to the env-var chain. A pre-baked absolute path in
  the `command` array is the smallest change.

## Consequences

- A user running `opencode .` after `scripts/install-opencode.sh`
  has the `red-memory`, `red-ui`, `code-nav`, and `brain` MCPs
  loaded as native opencode tools. The LLM can call
  `mcp_red-memory_recall`, `mcp_red-ui_*`, etc. directly, no
  per-skill MCP wrapping required.
- The Slice 1 `opencode.json` now embeds a `mcp:` block in
  addition to the `provider>` block. A re-emit (after a
  `red-memory` version bump, for example) re-resolves the
  bootstrap script path; a missing script is a build warning,
  not a silent failure.
- A release-asset install (Slice 5) emits an `opencode.json`
  with `mcp:` entries that point at the **release-resolved**
  paths. The release pipeline resolves the bootstrap script
  path against the release tarball's expected layout, and the
  emitted JSON is the same shape. The Slice 3 contract is
  forward-compatible with Slice 5.
- A user who has hand-installed the bootstrap script at a
  non-standard path is not supported. The Slice 3 search order
  is the well-known red-skills install layout; a custom path is
  a one-line opencode.json edit after the install, not a
  generator feature.
- Skills that depend on MCPs (every `memory:core/*` skill
  except `init`, every `brain:core/*` skill, the
  `dev:branch-lock` interaction) now work in the opencode TUI
  the same way they work in Claude Code and Codex. The Slice 1 +
  2 contract — "same source, three consumers" — extends to the
  MCP layer.

## Status

Accepted. Implements the Slice 3 MCP passthrough of the opencode-host
plan. The Slice 1 + 2 + 2.1 contracts (ADR 0075, 0076, 0077, 0078) are
unchanged; this ADR adds the `mcp:` block to the Slice 1
`opencode.json`.

## Related

- **0075** — Slice 1 (provider block); the `opencode.json` the
  Slice 3 generator extends.
- **0076** — Slice 2 (skills); same per-plugin dist tree.
- **0077** — Slice 2 (hooks); the `__pluginRoot` rewrite pattern
  Slice 3 applies to the bootstrap script path.
- **0078** — Slice 2.1 (install path); the install script
  surface that delivers the Slice 3 `opencode.json` to the
  user's `~/.config/opencode/`.
- **0029** — runtime ships as a Release asset; the
  `bootstrap.mjs` model Slice 3 inverts (the user has the source
  on disk, the generator resolves the path at build time
  instead of fetching a release).
- **0034** — monorepo definitions vs. implementation; the
  `mcp-passthrough` module reads the source `.mcp.json` and
  emits the opencode form, preserving the defs-vs-impl split.
