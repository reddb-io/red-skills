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

`CODE_NAV_ROOT` sets the workspace root (defaults to the process cwd, which Claude
Code sets to the project directory).

## Build

The plugin ships a pre-bundled `dist/index.js` (single self-contained file, no
`node_modules` needed at runtime). To rebuild after changing `src/`:

```bash
pnpm install
pnpm build      # typecheck + esbuild bundle
```

## Verifying

`pnpm dev` runs the server from source over stdio. The server logs language-server
output to stderr (prefixed `[<server>]`) so it never corrupts the MCP stdio channel.
