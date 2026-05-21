# memory — persistent memory for code agents

The `memory` plugin gives Claude Code / Codex agents a persistent, queryable
memory so decisions, gotchas, and why-notes survive `/clear` and cross sessions.
It **lives on top of the `dev` plugin** and is meant to improve dev's processes
(`/afk` recall, `/triage` dedup, `/diagnose` root-cause history). Installing
`memory` requires `dev`.

## This release: markdown-only

This is the first end-to-end slice (PRD #49). It ships the **markdown-only**
path — memory with zero engine dependency:

- `memory init` (markdown-only) writes `.red/memory/config.json` with **all
  hooks off, MCP off, and RedDB not required**, and creates `.red/memory/notes/`.
- `/memory:store <fact>` writes a plain markdown note.
- `/memory:recall <query>` returns matching notes via full-text search, ranked.

Nothing auto-fires. The graph/hybrid storage modes, the MCP server, the
auto-firing hooks, and the `/afk` · `/triage` · `/diagnose` integrations land in
later slices.

## Skills

| Skill | What it does |
|-------|--------------|
| **[init](./skills/core/init/SKILL.md)** | Setup wizard — markdown-only path. |
| **[store](./skills/core/store/SKILL.md)** | Save a fact as a markdown note. |
| **[recall](./skills/core/recall/SKILL.md)** | Full-text search over stored notes. |

## Build

The plugin ships **source only**; `dist/` and `node_modules/` are gitignored and
built on your machine at init time (needs only node + pnpm):

```bash
pnpm --dir plugins/memory install
pnpm --dir plugins/memory build
```

Then drive it directly if you like:

```bash
node plugins/memory/dist/cli.js init --mode markdown-only
node plugins/memory/dist/cli.js store the cache TTL is 300 seconds
node plugins/memory/dist/cli.js recall cache TTL
```

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
