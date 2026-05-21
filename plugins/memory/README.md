# memory — persistent memory for code agents

The `memory` plugin gives Claude Code / Codex agents a persistent, queryable
memory so decisions, gotchas, and why-notes survive `/clear` and cross sessions.
It **lives on top of the `dev` plugin** and is meant to improve dev's processes
(`/afk` recall, `/triage` dedup, `/diagnose` root-cause history). Installing
`memory` requires `dev`.

## Storage modes

`memory init` picks one storage mode. Two ship today:

- **markdown-only** — zero engine dependency. Writes `.red/memory/config.json`
  and `.red/memory/notes/`; `/memory:store` writes a plain markdown note,
  `/memory:recall` full-text-searches the notes.
- **graph** — a typed knowledge graph over a per-project embedded RedDB store at
  `.red/memory/graph.rdb`. `/memory:store` upserts a deduped `concept` node;
  `/memory:recall` runs the **hybrid recall engine** — full-text seeds expanded
  through the graph neighborhood, ranked, with the head of any `SUPERSEDED_BY`
  chain returned in place of superseded nodes. RedDB runs out-of-process from the
  SDK's bundled binary — no service to manage. Graph writes use multi-model DML
  and KV-backed dedupe; see [ADR 0007](../../.red/adr/0007-reddb-graph-writes-via-multi-model-dml.md).

Both keep **all hooks off** — nothing auto-fires. The auto-firing hooks and the
`/afk` · `/triage` · `/diagnose` integrations land in later slices.

## Graph read verbs (graph mode)

Beyond `recall`, graph mode exposes the read primitives directly — all
zero-token (no LLM):

```bash
node plugins/memory/dist/cli.js search <query>          # full-text node search
node plugins/memory/dist/cli.js neighbors <label>       # 1-hop neighborhood
node plugins/memory/dist/cli.js traverse <label>        # BFS/DFS walk
node plugins/memory/dist/cli.js path <from> <to>        # shortest path
node plugins/memory/dist/cli.js stats                   # node/edge counts
```

## MCP server

`memory-mcp` speaks MCP over stdio and exposes the same surface to agents:
`memory_recall`, `memory_store`, `memory_search`, `memory_traverse`,
`memory_neighbors`, `memory_path`, `memory_ask`, `memory_export`,
`memory_stats`, `memory_supersede`. `memory_recall` returns a ready-to-inject
markdown context block plus ranked nodes; `memory_ask` is the one LLM-backed
verb (it needs an engine API key and degrades gracefully without one).

It resolves its store from the project config (`.red/memory/config.json` in the
cwd or `$MEMORY_ROOT`, graph mode required), or from an explicit
`RED_MEMORY_URI`:

```bash
node plugins/memory/dist/mcp-server.js          # reads ./.red/memory/config.json
RED_MEMORY_URI=file:///abs/graph.rdb \
  node plugins/memory/dist/mcp-server.js        # explicit store
```

## Skills

| Skill | What it does |
|-------|--------------|
| **[init](./skills/core/init/SKILL.md)** | Setup wizard — markdown-only or graph. |
| **[store](./skills/core/store/SKILL.md)** | Save a fact (markdown note or graph node). |
| **[recall](./skills/core/recall/SKILL.md)** | Ranked search over stored memory. |
| **[ingest](./skills/core/ingest/SKILL.md)** | Walk a repo into the graph — code symbols + markdown structure (graph mode). |

## Build

The plugin ships **source only**; `dist/` and `node_modules/` are gitignored and
built on your machine at init time (needs only node + pnpm):

```bash
pnpm --dir plugins/memory install
pnpm --dir plugins/memory build
```

Then drive it directly if you like (swap `--mode graph` for the graph store):

```bash
node plugins/memory/dist/cli.js init --mode markdown-only
node plugins/memory/dist/cli.js store the cache TTL is 300 seconds
node plugins/memory/dist/cli.js recall cache TTL
```

`graph` mode needs the install step above (it pulls `@reddb-io/sdk` and its
bundled `red` binary); markdown-only needs only node.

## Develop

```bash
pnpm --dir plugins/memory test        # vitest
pnpm --dir plugins/memory typecheck   # tsc --noEmit
pnpm --dir plugins/memory build       # tsc → dist/
```

The TS workspace is self-contained under `plugins/memory/`; the red-skills root
stays build-free.

## License

Apache-2.0. See the repo [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
