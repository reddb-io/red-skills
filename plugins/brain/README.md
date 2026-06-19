# RedSkills Brain

RedSkills Brain is a project-local knowledge repository. It creates `.red/brain/*`
for the workspace, treats RedDB as the source of truth, and stores typed
artifacts plus graph connections for later search and synthesis.

Brain owns Personal facts: biographical details, identity context, durable human
preferences, relationship notes, and other human-facing context the user wants
available later. Capture those as Brain artifacts rather than Memory facts.

Brain root resolution prefers explicit overrides first, then walks up from the
current directory until it finds a real `.red/brain` directory or a
`.red/brain.root` marker. If neither exists, it falls back to the nearest
ancestor `.red/` directory for compatibility with existing repo-local behavior.

This lets an organisation folder hold an umbrella brain:

```text
~/work/reddb.io/.red/brain
~/work/reddb.io/api/.red
~/work/reddb.io/web/.red
```

Running `brain status`, `brain capture`, or `brain search` inside either child
repo targets `~/work/reddb.io/.red/brain`.

Set `RED_BRAIN_ROOT=/path/to/root` or add `plugins.brain.rootDir` to a
`.red/config.yaml` file to override walk-up resolution explicitly.

The default connection string is:

```yaml
connection_string: file://./.red/brain/brain.rdb
```

The value may reference a variable from the process environment or the workspace
root `.env` file:

```yaml
connection_string: $RED_BRAIN_CONNECTION_STRING
```

Brain is separate from the Memory plugin. Memory exists to make agents work
better; Brain exists to hold knowledge the user wants to dump, connect, search,
and synthesize. If the content is about the person or their context rather than
operational evidence from agent work, route it to Brain.

Search is deterministic hybrid ranking: lexical title/content matches, tag
matches, artifact kind matches, and graph connections all contribute to each
hit's `score_breakdown`. The contract already reserves a `vector` score slot, but
embeddings are not required for the local Brain MVP.

`brain think` turns that ranking into a cited Brain answer. It returns the
original hits plus stable `citations`, a deterministic `confidence` label, and a
`missing_evidence` list so the Brain can say when it has weak or absent evidence
instead of fabricating certainty. Citations point back to the Brain artifact rid,
kind, id, score signals, excerpt, and any captured source path/session/agent
provenance.

Brain can also act on a channel. `brain_act` (MCP) and `brain act --target
<channel> --message <text>` (CLI) post a message to a channel target through the
Channel bridge in outbound-only mode: the bridge sends standalone using
configured channel tokens, with no gateway daemon required. Missing-token,
bad-target, and unreachable-bridge failures surface as clear brain-scoped errors;
the raw Hermes `messages_send` tool stays hidden.

Core skills: [capture](./skills/core/capture/SKILL.md),
[search](./skills/core/search/SKILL.md), [think](./skills/core/think/SKILL.md),
[status](./skills/core/status/SKILL.md), and
[view](./skills/core/view/SKILL.md). `view` opens `brain.rdb` in red-ui for
graph/connection exploration.

`brain dashboard` generates the separate daily-driver surface: a self-contained
HTML overview with KpiQuery-backed event metrics, recent decisions, and recent
typed connections. It is intentionally not a node-link graph and does not reuse
the Memory Workbench. Use `brain dashboard --out dashboard.html` for a file,
`brain dashboard --json` for the underlying `brain.dashboard.v1` contract, or
`brain dashboard --serve --port 4738` for a loopback local URL.
