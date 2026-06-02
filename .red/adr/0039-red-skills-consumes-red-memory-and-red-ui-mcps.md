# red-skills consumes `red-memory` and `red-ui` MCPs; it stops building the memory plugin

## Context

The red ecosystem has a dedicated repo per product:

- `reddb` — the embedded multi-model engine.
- `red-memory` — the local-first graph+markdown memory plugin for Claude Code, backed by RedDB (`packages/mcp-server/`, hooks, CLI). Currently **pre-alpha**.
- `red-ui` — the universal RedDB client, one Svelte source shipped three ways: embeddable web component (`@reddb-io/ui/embed`), an MCP *App* server (`@reddb-io/ui-mcp`, renders the client inside an MCP host), and a Tauri desktop app.

red-skills historically **built** the memory plugin under `src/apps/memory` (mature, ~55k lines) and exposed it as the `memory` MCP — even though `red-memory` is the dedicated home. The mature implementation lived here; the dedicated repo was the empty shell. Separately, the memory MCP name was inconsistent across three surfaces (`memory` registered, but the routing-guide advertised `reddb-memory` + `command: memory-mcp` + `MEMORY_ROOT`, a command/env that does not match the real bootstrap invocation).

There are two distinct MCPs in play, repeatedly conflated:

- a **data** MCP — the memory tools (`memory_recall`, `memory_store`, `memory_search`, traverse/neighbors/path, sessions, supersede, export, …); it connects to the embedded RedDB **and** serves the tools (one server, not two).
- a **visualizer** MCP — red-ui's `ui-mcp` (MCP App) that renders the red-ui client over the same RedDB so a human can *see* the memory graph.

## Decision

1. **red-skills is a consumer, not the home, of memory and UI.** The mature `src/apps/memory` **migrates to the `red-memory` repo** (its canonical home), which becomes the source of the memory plugin/MCP. `src/apps/memory` is retired from red-skills after the migration lands.

2. **Canonical MCP names align with their owning repo:**
   - **`red-memory`** — the data/tools MCP (was `memory` / the never-settled `reddb-memory`). Tools keep the `memory_*` prefix; only the server name changes.
   - **`red-ui`** — the visualizer MCP App (was `ui-mcp` / `@reddb-io/ui-mcp`).
   - **`code-nav`** — unchanged; stays built in red-skills under the `dev` plugin. The brand-prefix asymmetry (`code-nav` not `red-code-nav`) is accepted.

3. **red-skills pulls both as bundles from their repos' GitHub releases** (the fetch model of ADR 0029) — one fetch mechanism across the ecosystem, no npm-registry runtime dependency. The memory plugin's `.mcp.json` references `red-memory` (data) and `red-ui` (visualizer); red-skills builds neither.

4. **Prerequisites in the owning repos:**
   - `red-memory` receives the migrated implementation and publishes a self-contained bundle as a GitHub release asset.
   - `red-ui` bundles `ui-mcp` self-contained and attaches it to its release (today it only npm-publishes `@reddb-io/ui-mcp` + attaches desktop/embed assets).

## Consequences

- red-skills shrinks to the `dev` plugin (code-nav, AFK, skills) plus thin consumption of `red-memory` / `red-ui`. The ~55k-line memory app, its tests, hooks, and memory skills leave for `red-memory`.
- Per-repo ownership mirrors the product split (reddb / red-memory / red-ui); the visualizer is never duplicated here.
- `memory` → `red-memory` is a **client-contract rename**: any agent config or doc referencing the `memory` MCP server must update; the routing-guide is fixed to emit the real runnable command.
- **Large multi-repo migration** — sequenced, not atomic: stand up `red-memory` from the migrated code, bundle + release it, bundle `red-ui`'s `ui-mcp`, then rewire red-skills' `.mcp.json` to fetch both, then retire `src/apps/memory`. Open red-skills issues (#370–#374 and others) that target `src/apps/memory` move with it.
- **Partially reverses ADR 0034** (which placed memory under `src/apps/memory`) — for memory only; `dev` stays in red-skills.

## Status

Accepted (direction). The multi-repo migration is large and pending; until it lands, `src/apps/memory` remains the live source.

## Related

- ADR 0029 — runtime ships as a release-asset bundle fetched by a bootstrap (the fetch model reused here).
- ADR 0034 — monorepo `src/apps` domains (partially reversed for memory).
- `../red-memory`, `../red-ui` — the owning repos.
