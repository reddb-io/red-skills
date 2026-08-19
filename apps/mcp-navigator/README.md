# code-nav — LSP-backed code navigation (MCP server)

Gives a code agent the same symbol-level navigation a developer has in their IDE,
exposed as Model Context Protocol tools. Instead of grepping for a name and
guessing which match is the real one, the agent asks a language server semantic
questions and gets exact answers.

This is the "high-value LSP integration" recommended for large codebases in
[*How Claude Code works in large codebases*](https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start):
agentic search stays the default, and LSP adds symbol precision on top.

## Tools

| Tool | What it does |
|------|--------------|
| `workspace_symbols` | Find a symbol by **name** across the workspace. Start here when you know a name but not where it lives. |
| `goto_definition` | Resolve the symbol at a position to its definition(s). |
| `find_references` | Every reference to the symbol at a position — semantic, not text. |
| `document_symbols` | Semantic outline of a file (types, functions, methods). |
| `hover` | Type signature + docs for the symbol at a position, as the IDE hover card. |

Typical agent flow: `workspace_symbols("FooBar")` → take a position →
`goto_definition` / `find_references` from there. No line/column guessing.

## How it works

A thin LSP client (`vscode-languageserver-protocol` over stdio) spawns the
language server for a file's extension, runs the `initialize` handshake, opens
documents lazily (`textDocument/didOpen`), and forwards each MCP tool call to the
matching LSP request. One server process per language, reused across calls.

## Configured languages

Defaults map extensions to common language servers; a server is only spawned when
a file of its type is queried, and a missing binary is skipped without crashing
the others.

| Language | Server (must be on `PATH`) | Extensions |
|----------|----------------------------|------------|
| TypeScript / JS | `typescript-language-server --stdio` | `.ts .tsx .js .jsx .mts .cts .mjs .cjs` |
| Go | `gopls` | `.go` |
| Rust | `rust-analyzer` | `.rs` |
| Python | `pyright-langserver --stdio` | `.py .pyi` |

Override or add servers with the `CODE_NAV_SERVERS` env var (JSON merged over the
defaults):

```jsonc
CODE_NAV_SERVERS='{"clangd":{"command":"clangd","args":[],"extensions":[".c",".cpp",".h"],"languageId":"cpp"}}'
```

## Workspace root

The root the language servers index follows the **opened project**, not the
plugin the launcher lives in. Precedence:

1. `CODE_NAV_ROOT` — the operator's own word, obeyed as written.
2. The project the host announces: `RED_SKILLS_PROJECT_ROOT`,
   `CLAUDE_PROJECT_DIR`, `CODEX_PROJECT_DIR`, `OPENCODE_PROJECT_DIR`.
3. The process cwd.

A candidate that is recognisably a plugin installation — it carries a plugin
manifest, sits in a host's plugin cache, or is the plugin root the host itself
announced — is skipped at steps 2 and 3. The navigator is launched from a script
inside the installed plugin, so an unguarded cwd indexed the plugin instead of
the repository and every lookup answered "not found" as if a language server
were missing. When the plugin directory is genuinely all that is left, the root
is used anyway and the ready line on stderr says so, naming `CODE_NAV_ROOT` as
the fix.

The ready line carries both: `navigator MCP ready (root=…, root-source=…, languages=…)`.

## Build

Following ADR 0034 (layout relocated by ADR 0060), this package is the
*implementation* (it lives under `apps/mcp-navigator`, outside the plugin
definition). `build` emits a
single self-contained bundle to the repo-root `dist/` — no `node_modules` is
needed at runtime. To rebuild after changing `src/`:

```bash
pnpm install
pnpm --filter @reddb-io/code-nav-mcp build  # -> dist/code-nav-mcp.bundle.min.mjs
```

The dev plugin resolves the bundle dynamically (`plugins/dev/.mcp.json`): the
dynamic-fetch cache (`<cache>/code-nav-<version>.bundle.min.mjs`, populated by the
`SessionStart` hook calling `red-fetch.mjs code-nav <version>`) first, then the
repo-root `dist/code-nav-mcp.bundle.min.mjs` for a dev checkout. On release it
ships as the `code-nav.bundle.min.mjs` asset with a `code-nav.manifest.json`
checksum.

## Verifying

`pnpm dev` runs the server from source over stdio. The server logs language-server
output to stderr (prefixed `[<server>]`) so it never corrupts the MCP stdio channel.
