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
  `/memory:recall` scans the graph, expands the top matches one hop, and returns
  the head of any `SUPERSEDED_BY` chain. RedDB runs out-of-process from the SDK's
  bundled binary — no service to manage. Graph writes use multi-model DML and
  KV-backed dedupe; see [ADR 0007](../../.red/adr/0007-reddb-graph-writes-via-multi-model-dml.md).

Both keep **all hooks off and MCP off** — nothing auto-fires. Hybrid mode, the
MCP server, the auto-firing hooks, and the `/afk` · `/triage` · `/diagnose`
integrations land in later slices.

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
