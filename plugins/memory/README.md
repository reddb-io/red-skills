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
  through the graph neighborhood, then ranked by `importance × recency ×
  graph-centrality × tier-weight` (durable decisions outrank reasoning traces
  outrank ephemeral session noise), with the head of any `SUPERSEDED_BY` chain
  returned in place of superseded nodes (`--include-superseded` returns the full
  chain). RedDB runs out-of-process from the
  SDK's bundled binary — no service to manage. Graph writes use multi-model DML
  and KV-backed dedupe; see [ADR 0007](../../.red/adr/0007-reddb-graph-writes-via-multi-model-dml.md).

**markdown-only keeps all hooks off** — nothing can auto-fire, there is no
engine to recall from or index into. **graph mode** can opt into the four
auto-firing hooks below; they default off and are turned on at `memory init`.
The `dev` plugin soft-uses Memory for `/afk`, `/triage`, `/diagnose`, and
`/zoom-out` when it is initialized; absence or failure degrades to the original
workflow instead of becoming a hard dependency.

## Auto-firing hooks (graph mode, opt-in)

When enabled at init, four hooks let memory work without anyone typing a
command. Each is **gated on the config**: if memory is not initialized, is in
markdown-only mode, or the matching hook flag is off, the hook reads the config
and exits silently — a dormant hook never touches the engine or the turn.

| Hook | Fires on | Does |
|------|----------|------|
| **SessionStart** | session start / resume / `/clear` | recalls memory relevant to the focus (goal/branch/cwd) and injects it as context |
| **PostToolUse** | a file edit (`Edit`/`Write`, or Codex `apply_patch`) | incrementally re-indexes the changed file into the graph |
| **Stop** | end of an assistant turn | extracts decisions / why-notes from the turn and stores them |
| **PreCompact** | before a context compaction / `/clear` | flushes ephemeral session knowledge to memory — the anti-goldfish save |

Extraction (Stop / PreCompact) runs through a **bounded-LLM extractor** in
production; with no LLM key configured it falls back to a deterministic
heuristic so the hooks still capture cued decision / why-note sentences. Recall
and re-indexing are always zero-token.

### Both runners — and the Codex `PreCompact` gap

The hooks ship for **both runtimes**. `hooks/claude.hooks.json` (wired from
`.claude-plugin/plugin.json`) uses Claude's event names and the `Edit|Write`
matcher; `hooks/codex.hooks.json` (wired from `.codex-plugin/plugin.json`) uses
Codex's event names and the `apply_patch` matcher. On Codex the hooks system is
gated behind `[features].plugin_hooks = true` (off by default — `memory init`
tells Codex users to enable it). The single `memory hook <event> --runner <r>`
CLI entrypoint dispatches both runners, mapping each one's payload and output
shape internally.

**Known difference: Codex has no `PreCompact` equivalent** — no compaction /
context-trim event exists, so the anti-goldfish flush-before-context-death
safety net is absent there. On Codex the flush leans on `Stop` (extract every
substantive turn) plus `SessionStart`-on-`/clear` recall instead.

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

## Competitive baseline

`memory` carries a checked-in competitive harness so the README comparison is
backed by executable assertions instead of marketing copy:

```bash
pnpm --dir plugins/memory baseline:competitive
pnpm --dir plugins/memory test -- competitive-baseline
```

The fixture summary comes from the existing `reddb-benchmark/graphify-out`
run: 551 nodes, 1329 edges, 34 detected communities, 491 inferred edges, and
zero reported input/output tokens. The harness encodes measurable "better than"
claims for embedded footprint, session lifecycle integration, and the repo's
recall-latency budget. It deliberately does **not** claim an apples-to-apples
latency win over `neo4j-labs/agent-memory`; that comparison needs a live Neo4j
baseline.

| Axis | `memory` | `graphify` | `agent-memory` | Framing |
|------|----------|------------|----------------|---------|
| Zero-ops / embedded footprint | Embedded RedDB file store; no daemon to administer. | Python CLI plus checked-in `graphify-out`; no database daemon, but a separate toolchain. | Neo4j-backed SDK/MCP; needs a Neo4j instance or hosted service. | Advantage: embedded RedDB store, no Python or Neo4j service. |
| Session lifecycle integration | Native SessionStart, PostToolUse, Stop, and PreCompact hooks in graph mode. | Assistant instructions and optional search nudges; not a memory lifecycle. | SDK/MCP integration; no RedSkills hook lifecycle. | Advantage: memory is built into the agent session lifecycle. |
| Engine feature breadth | TTL, KV/cache overlays, native Louvain, ASK; geospatial is not exposed by memory yet. | Static graph export with query/path/explain and 34 detected communities in the fixture. | Neo4j graph, vector/text search, geospatial, MCP tools, eval harness, and framework adapters. | Parity/mixed: both graph competitors have useful breadth; memory wins embedded RedDB primitives, agent-memory wins Neo4j ecosystem breadth. |
| Recall latency on agent-scale graph | Repo gate targets <100 ms p50 on a ~1k-node graph. | graphify-out fixture: 551 nodes / 1329 edges / 34 communities; path p50 841 ms. | Not asserted here; apples-to-apples latency requires a live Neo4j baseline. | Advantage over checked graphify-out path latency only; no latency claim against agent-memory in this harness. |
| NER extraction quality | Deterministic extractors plus optional LLM provider for inferred facts. | 491 inferred fixture edges; strong static-code graph output. | spaCy / GLiNER / GLiREL / LLM extraction pipeline. | Conceded gap: Python ML stack is ahead for turnkey NER. |

## Maintenance & export (graph mode)

```bash
node plugins/memory/dist/cli.js doctor                  # list stale nodes
node plugins/memory/dist/cli.js doctor --prune          # prune (confirms first)
node plugins/memory/dist/cli.js export [<out-dir>]      # graph.json + graph.html + audit.md
```

`doctor` flags nodes unaccessed for 90+ days (`--stale-days N` to change) that
have never been recalled, and prunes them **only after explicit confirmation** —
never automatically. Pinned nodes (`importance >= 0.8`) are exempt. Recall bumps
each hit's access counter, so frequently-recalled nodes stay fresh.

`export` writes a self-contained, navigable `graph.html` (data inlined, opens
from disk — no server) alongside `graph.json` and a health-summary `audit.md`.

## MCP server

`memory-mcp` speaks MCP over stdio and exposes the same surface to agents:
`memory_recall`, `memory_store`, `memory_search`, `memory_traverse`,
`memory_neighbors`, `memory_path`, `memory_ask`, `memory_export`,
`memory_doctor`, `memory_stats`, `memory_supersede`. `memory_recall` returns a ready-to-inject
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
| **[extract](./skills/core/extract/SKILL.md)** | Extract durable `INFERRED` facts from a transcript using the configured provider (graph mode). |
| **[skills-status](./skills/core/skills-status/SKILL.md)** | Diagnose Skill telemetry and recent Skill usage before curation/self-improvement. |
| **[context-status](./skills/core/context-status/SKILL.md)** | Report context stack readiness across agent rules, domain docs, ADRs, Memory graph/telemetry, Wiki, score, and recommendations. |
| **[doctor](./skills/core/doctor/SKILL.md)** | Flag stale nodes and prune them after confirmation (graph mode). |
| **[export](./skills/core/export/SKILL.md)** | Export the graph to a navigable graph.html + graph.json + audit.md (graph mode). |

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
