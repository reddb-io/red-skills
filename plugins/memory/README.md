# memory — governed operational memory for code agents

The `memory` plugin gives Claude Code / Codex agents governed operational
memory: scoped decisions, gotchas, reasoning traces, provenance, supersession,
and trust checks that survive `/clear` and cross sessions. It is not a generic
graph clone or a note bucket; the useful unit is agent work evidence that can be
recalled, verified, aged, superseded, exported, and used by RedSkills workflows.
It is also not a Personal-fact store: Odysseus-style biographical facts,
identity details, long-lived human preferences, and other human-facing context
belong in Brain artifacts under `.red/brain/*`.

It **lives on top of the `dev` plugin** and is meant to improve dev's processes
(`/afk` recall, `/triage` dedup, `/diagnose` root-cause history, `/zoom-out`
orientation). Installing `memory` requires `dev`.

> **Runtime model.** The implementation now lives in `apps/plugin-memory/`
> (monorepo `domains/` layout); only the plugin *definition* (hooks, skills,
> docs) stays under `plugins/memory/`. The built runtime ships as a GitHub
> Release bundle (ADR 0034), not as committed `dist/` output. Examples below
> invoke the published bins — `memory` (CLI, including the `/curate` workflow)
> and `memory-mcp` (MCP stdio server) — instead of the old
> `node plugins/memory/dist/cli.js …` paths, which no longer exist.

## What this plugin is

Memory has one job: make future agents safer and faster by turning work evidence
into governed context. The core path is intentionally small:

| Step | Command surface | What good output looks like |
|------|-----------------|-----------------------------|
| Initialize | `memory init` / `$init` | A project-local `.red/memory` surface with either markdown-only notes or graph-backed governed memory. |
| Capture | `memory store` / `$store`, hooks, `memory extract` | One scoped operational decision, gotcha, validation, risk, or root-cause fact with enough provenance to verify later. |
| Recall | `memory recall` / `$recall`, SessionStart hooks | A compact set of relevant claims/evidence, ranked by usefulness and hiding superseded guidance by default. |
| Verify | `claim-check`, `readiness`, `governance`, `lint`, `decay`, `health` | Stale, contradicted, unsupported, or risky claims are visible before an agent acts on them. |
| Handoff | `context-pack`, `handoff`, Workbench panels | Cited context that another agent/session can inject without replaying the whole history. |

Everything else exists to support that loop. MCP/HTTP, Workbench pages, graph
reads, smart search, vector diagnostics, reference evals, and export commands
are operator and integration surfaces over the same evidence store; they should
not become a second source of truth.

## Which mode should I use?

| Need | Use | Why |
|------|-----|-----|
| Lowest-risk searchable notes in any repo | `markdown-only` | No RedDB engine, hooks, MCP, provider, or background process; facts are plain markdown under `.red/memory/notes/`. |
| Agent workflow memory with provenance, freshness, supersession, and claim checks | `graph` | Stores operational evidence in `.red/memory/graph.rdb` and powers governed recall/readiness/handoff. |
| Automatic lifecycle capture | `graph --hooks` | SessionStart/PostToolUse/Stop/PreCompact hooks can recall, refresh, and extract evidence when the host supports them. |
| Browser/API/operator inspection | `graph` + `memory serve` or `memory workbench` | Read-only Workbench, dashboard, docs/search, governance, health, and routing panels over the local store. |
| Semantic/vector diagnostics | `graph` + `memory vector maintain` | Optional projection for search diagnostics; governed recall remains the canonical agent-context path. |

Default recommendation: start with `markdown-only` for a cautious rollout, then
switch new projects to `graph --hooks --skill-telemetry` once you want the full
RedSkills workflow loop.

## Common workflows

Use this map before reaching for the full command list:

| If you want to... | Start with | Why |
|-------------------|------------|-----|
| Remember one plain-note work fact | `memory store "Decision: ..."` | Captures scoped evidence for later recall in markdown-only or low-friction setups. |
| Store governed validation evidence | `memory store-evidence ...` / `memory_store_evidence` | Requires source reference, citation excerpt, intent, and observer identity before durable graph write. |
| Get context before acting | `memory recall "topic"` | Canonical governed context path; hides superseded guidance by default. |
| Prepare another agent/session | `memory context-pack "goal"` or `memory handoff "focus"` | Produces cited, budgeted context instead of dumping search results. |
| Narrow code reads before broad grep | `memory onboarding-map --json`, `memory structural-impact --file <path>`, `memory path-explain <from> <to> --json` | Produces RedDB-backed map context so the agent can inspect the most relevant files, symbols, tests, decisions, and references first. |
| Decide whether it is safe to proceed | `memory readiness "goal"` or `memory claim-check "assertion"` | Surfaces stale, missing, contradicted, or unsupported evidence. |
| Search across every indexed surface | `memory smart-search "query"` | Broad discovery across recall, docs, assets, and vector diagnostics. |
| Operate/debug Memory itself | `memory workbench`, `memory health-viewer`, `memory governance` | Inspects capability status, freshness, hooks, trust, and retention. |

The rule of thumb: agents should use `recall` for action context, `readiness`
for go/no-go decisions, `context-pack`/`handoff` for continuation, and map
context before broad source reads. Code-structure map context is agent context:
it narrows the next source files to inspect and must be verified against the
current worktree before the agent makes a code claim. Broader search, Workbench,
vector, docs, and reference surfaces are diagnostics or operator views over the
same evidence.

## Golden path: governed operational memory

The plugin ships source-only. From a checkout of `red-skills`, build the local
CLI first; `dist/` and `node_modules/` are intentionally not committed.

```bash
pnpm --dir apps/plugin-memory install
pnpm --dir apps/plugin-memory build
```

For the smallest useful setup, initialize markdown-only mode in the repo whose
work you want to remember:

```bash
memory init --mode markdown-only --yes
memory store "Decision: API cache TTL is 300 seconds because upstream rate limits."
memory recall "cache TTL"
```

That path writes plain notes under `.red/memory/notes/` and gives agents a
best-effort recall surface with no RedDB engine, hooks, MCP server, telemetry,
or provider key. It is a low-risk way to make durable facts searchable before a
later `/afk`, `/triage`, or `/diagnose` session.

Use graph mode when you want governed operational memory rather than plain
notes: graph recall, provenance, supersession/conflict edges, context packs,
claim checks, readiness, event-log evidence, Skill telemetry, MCP read tools,
and optional lifecycle hooks.

```bash
memory init --mode graph --hooks --skill-telemetry --yes
memory store-evidence \
  --claim "Validation: API cache TTL is 300 seconds." \
  --source-ref "docs/cache.md:12" \
  --citation-excerpt "API cache TTL is 300 seconds." \
  --intent validation \
  --observer claude-smoke-runner
memory claim-check "API cache TTL is 300 seconds." --json
memory readiness "prepare an AFK fix for cache expiry" --json
memory handoff "cache expiry" --json
memory context-pack "diagnose flaky cache expiry tests"
memory recall "cache TTL"
```

That is the canonical Init → Store → Recall → Verify → Handoff loop:

1. **Init** creates a project-local memory surface.
2. **Store** captures one durable, scoped work fact with enough “why” to be useful later.
3. **Recall** produces governed zero-token context; graph mode keeps the hot path deterministic and treats vectors as optional contributors, not the source of truth.
4. **Verify** uses claim checks/readiness/governance to separate evidence from stale or contradicted claims.
5. **Handoff** turns the evidence into a compact context pack for the next agent/session.

The product promise is operational memory for code agents: remember decisions,
gotchas, reasoning traces, validations, and lifecycle evidence in a way that can
be aged, superseded, audited, exported, and injected back into RedSkills work.
Vectors, docs search, dashboards, and graph analytics are supporting surfaces;
`memory recall` remains the canonical governed context path.

## 60-second governed cross-agent flow

The first-run Memory story should prove Mistakes avoided before it talks about
token savings: one runner stores source-cited validation evidence through the
governed write surface, another runner recalls it with provenance, and both can
see why the claim is safe to reuse. The older generic `memory_store` MCP tool
still exists for compatibility, but the recommended governed write story is
`memory store-evidence` on the CLI or `memory_store_evidence` over MCP because
both require source reference, citation excerpt, intent, and observer identity.

1. As the writer runner, store the validation evidence:

   ```bash
   memory store-evidence \
     --claim "Validation smoke proves cross-agent governed Memory recall." \
     --source-ref "issue-871-cross-agent-memory-smoke.md:17" \
     --citation-excerpt "Validation smoke proves cross-agent governed Memory recall." \
     --intent validation \
     --observer claude-smoke-runner \
     --json
   ```

2. As a different runner, recall the same evidence and inspect provenance:

   ```bash
   memory recall "cross-agent governed Memory recall validation smoke" --json
   memory provenance <rid> --json
   memory store-evidence \
     --claim "Codex runner recalled the governed validation smoke with provenance." \
     --source-ref "issue-871-cross-agent-memory-smoke.md:17" \
     --citation-excerpt "Validation smoke proves cross-agent governed Memory recall." \
     --intent validation \
     --observer codex-smoke-runner \
     --json
   ```

3. Act only after the recalled node shows the original `provenance.writer`,
   `provenance.evidence`, source reference, and citation excerpt. That is the
   operator-visible mistake avoided: the second agent does not re-broaden the
   search, trust an uncited note, or repeat validation work from memory alone.
   The token savings are supporting evidence, not the headline.

Executable guards back this public story: `governed-cross-agent-smoke` is tied
to `foundation:governed-write-cli`,
`foundation:cross-agent-governed-recall`, and
`foundation:mistake-avoided-bench`. The mistake_avoided benchmark explicitly
marks full autonomous failure learning unavailable; it does not claim shipped
`memory learn` or `memory refine` behavior.

Graph mode provisions a per-project embedded RedDB file at
`.red/memory/graph.rdb` through the bundled SDK binary; there is no daemon to
administer, but the build/install step is required. LLM-backed extraction and
`memory ask` need a configured provider (`provider` in
the `plugins.memory` block of `.red/config.yaml`, with any referenced API-key env var exported before
use). Without a provider key, deterministic store/recall, graph reads, claim
checks, readiness, exports, and most hooks still run; ASK reports unavailable,
and `memory extract --local` can still ingest explicit structured transcript
lines such as `Decision: ...`, `Problem: ...`, `Fix: ...`, and
`Validation: ...`.

To seed an existing repository quickly, graph mode can bootstrap from the
project's README, agent rules, docs, `.red/CONTEXT.md`, `.red/contexts/*.md`,
and ADRs, with an optional recent git-log document:

```bash
memory bootstrap --root . --dry-run --json
memory bootstrap --root . --include-git-log
memory docs coverage --root . --json
memory backup create --root . --name before-refactor
```

Bootstrap writes through the same markdown ingest path as `memory ingest`, so
document chunks, graph roots, deterministic references, vector projection
status, and retention posture all show up in doc coverage and the operational
dashboard. The ingest path also inventories binary corpus assets such as PDFs,
images, audio, video, and Office files as RedDB `file` nodes with media type,
size, hash, and provenance. That gives agents Graphify-style corpus awareness
without claiming OCR, transcripts, or multimodal embeddings.
Use `memory assets --json` or `memory assets-viewer` to inspect that inventory
through the same read-only CLI/MCP/HTTP surfaces as the rest of Memory.

`memory backup create|list|inspect|restore` snapshots the project-local
`.red/memory` persistence surface, including the RedDB graph files, config, and
markdown notes, under `.red/memory/backups/<name>` with a SHA-256 manifest.
Restore is intentionally gated by `--yes` and creates a pre-restore safety
backup before replacing the current persistence files.

## Read surfaces and operator diagnostics

Use this section when you need to inspect, integrate, or debug Memory rather than
just store and recall facts. The surfaces below are read-only unless explicitly
documented otherwise:

| Surface | Primary command | Best for |
|---------|-----------------|----------|
| Governed recall | `memory recall <query>` | Agent context injection from operational evidence. |
| Smart search | `memory smart-search <query>` | Broad discovery across recall, docs, assets, and vector diagnostics. |
| Context pack | `memory context-pack <goal>` | Budgeted, cited context for a specific task. |
| Handoff | `memory handoff [focus]` | Cross-session/cross-agent continuation brief. |
| Workbench | `memory workbench` / `memory serve` | Local browser cockpit for dashboards, governance, docs, hooks, routing, and health. |
| MCP/HTTP | `memory-mcp`, `memory serve` | Read access for Claude/Codex/Cursor/Gemini/Aider/OpenCode/generic agents. |
| Export/backup | `memory export`, `memory backup` | Offline audit, interop, and rollback safety. |
| Architecture overview | `memory architecture-overview` | One-read onboarding map of layers/communities and their connection counts, built from the `graph.json` contract; complements (does not replace) the wiki. |

### Memory Workbench and diagnostics

For optional browser/API inspection, `memory serve` starts a loopback-only
read-only HTTP surface over the same RedDB store. It serves the Memory Workbench
and dashboard HTML, prints the docs reference graph viewer URL at
`/docs/reference-graph`, plus JSON endpoints for health, OpenAPI
(`/openapi.json`), workbench, dashboard, references radar, context packs,
work frontier, memory layers, governance, decay, memory health, hook coverage,
agent integration status, session timeline, extraction status,
docs search/read/coverage/reference-graph, smart search, and recall; use
`--token-env MEMORY_HTTP_TOKEN` to require a bearer token.

`memory smart-search <query>` is the single read-only search entry point for
agents that want breadth first: it returns a fused `top_results` list plus the
underlying governed recall hits, ingested document hits, asset inventory hits,
and vector diagnostics.
`memory smart-search-viewer <query>` writes the same contract as a
self-contained HTML artifact with embedded JSON, source counts, fused results,
asset/vector detail, and recommended next actions.
This is deliberately not a vector-first ranking path; `memory recall` remains
the canonical governed memory context surface.

`memory context-pack-viewer <goal>` writes the budgeted, cited context pack as
a self-contained HTML artifact with embedded JSON, grouped evidence, warnings,
skill recommendations, and ready-to-inject Markdown. The same viewer is
available through MCP and `/context-pack?goal=<text>` when `memory serve` is
running.

`memory onboarding-map`, `memory structural-impact`, `memory path-explain`, and
`memory pre-pr-review` form the code-structure map context path. Agents should
call these before broad `grep`, recursive file reads, or opening many source
files when the question is about implementation shape or blast radius. The map
is not a generated answer; it is a RedDB context slice for deciding which files,
symbols, tests, prior decisions, active work, and references to inspect next.
Use relation filters while reading the map:

| Code question | Relation filters | Start with |
|---------------|------------------|------------|
| Which files should I inspect before changing this symbol? | `call`, `import`, `type`, `validation` | `memory structural-impact --file <path>` or MCP `memory_structural_impact` |
| Why does this handler depend on this schema or concept? | `call`, `type`, `reference`, `decision` | `memory path-explain <from> <to> --json` or MCP `memory_path_explain` |
| What work and validation evidence touches these changed files? | `work`, `validation`, `decision`, `reference` | `memory pre-pr-review --json` or MCP `memory_pre_pr_review` |

`memory layers --json` is the architecture-level readiness report: it maps
short-term session events, long-term durable graph facts, reasoning traces,
docs/code graph evidence, and vector projection into one RedDB-backed contract.
This makes Neo4j-style layered memory inspectable without introducing a graph
daemon or separate persistence service.
`memory layers-viewer` writes the same contract as a self-contained HTML
viewer with embedded JSON, layer counts, RedDB collections, reference
alignment, and recommended next actions.

`memory references-radar` is an internal planning report that maps capability
catalog evidence to named reference axes and next actions. It is intentionally
read-only and does not create public benchmark claims.

`benchmark-memory references eval` runs the checked-in reference eval harness and
prints a human-readable summary of the composite score, each dimension status,
and any unsupported public claims. `benchmark-memory references eval --json` emits the
same report as machine-readable JSON for CI and `references:eval:v2` consumers.
The command operates on checked-in fixtures and the source tree — it does not
mutate Memory state and does not make live-service reference claims.

```bash
benchmark-memory references eval
# memory reference eval: 6/6 pass
#   retrieval: 1/1 pass
#   readiness: 1/1 pass
#   operator-surface: 1/1 pass
#   multi-agent-integration: 1/1 pass
```

`benchmark-memory references viewer` writes the same eval contract as a
self-contained HTML viewer with embedded JSON. By default it writes to
`.red/memory/reference-eval.html` under the current root; pass
`--out <file>` to override the destination.

```bash
benchmark-memory references viewer
# benchmark-memory: reference eval viewer written .red/memory/reference-eval.html
#   composite: 6/6 pass
#   contract: memory.reference_eval.v2
```

The local **Memory Workbench** is the umbrella for the browser-facing operator
surface. It embeds the radar beside the operational dashboard, capability
catalog, memory layers, and session timeline, so `memory workbench` and
`memory serve` show the same internal posture report without recomputing it.
When served over HTTP, the Workbench also includes a read-only Search Console
backed by `/api/search`; it shows fused smart-search results, recall/doc/asset/
vector counts, result sources, references, and recommended next actions. The
static HTML artifact keeps the same UI and explains that search needs
`memory serve`.
It also includes a Context Pack panel backed by `/api/context-pack` with a link
to `/context-pack`, so a concrete agent goal can be turned into grouped,
budgeted, cited context without leaving the local UI.
It also includes a Work Frontier panel backed by `/api/frontier` with a link to
`/frontier`, so remembered task/issue/goal/PRD evidence can be ranked into
ready, blocked, and completed work without mutating work state.
It also includes a Docs Explorer backed by `/api/docs/search`, `/api/docs/read`,
and `/api/docs/related`, with HTML handoff pages at `/docs/search`,
`/docs/evidence-pack`, and `/docs/related`, plus `/api/docs/coverage` and
`/api/docs/reference-graph` for graph/vector coverage and extracted reference
topology, so indexed documentation can be searched, opened, related, audited,
and mapped from the same local cockpit.
For graph-heavy debugging, the Workbench includes a Graph Path Explorer backed
by `/api/path-explain`, exposing directed path evidence without leaving the
browser.
For map-first onboarding, it includes an Onboarding Map panel backed by
`/api/onboarding-map`; `/onboarding-map` serves the same concepts, workflows,
decisions, risks, validations, suggested skills, and warnings as a
self-contained HTML viewer.
For graph analytics debugging, it includes a Graph Communities panel backed by
`/api/communities`; `/communities` serves the same RedDB native community
assignments as a self-contained HTML viewer without writing clusters back into
Memory evidence.
For embedding diagnostics, it includes a Vector Diagnostics panel backed by
`/api/vector/status` and `/api/vector/search`; maintenance remains an explicit
CLI action. `/vector/status` serves the projection readiness as a
self-contained HTML viewer.
For hook debugging, it includes a Hook Diagnostics panel backed by
`/api/hooks/coverage` and `/api/session/timeline`, so lifecycle wiring and
recent hook evidence are visible without leaving the browser. `/hooks/coverage`
serves the same coverage as a self-contained HTML viewer.
For extraction debugging, it includes an Extraction Status panel backed by
`/api/extraction/status`, so deterministic extractor coverage, local structured
fallback readiness, provider configuration, Stop hook readiness, and inferred
fact counts are visible beside hooks and vectors. `/extraction/status` serves
the same readiness contract as a self-contained HTML viewer.
For trust debugging, it includes a Governance panel backed by
`/api/governance`, so provenance coverage, privacy findings, lint findings,
contradictions, and supersession counts are visible without mutating Memory.
`memory lint --json` also returns read-only rule-promotion suggestions for
agent rule files or Red context files when findings show secrets, imperatives,
transient progress, missing scope/tier, or duplicate guidance. `/governance`
serves the same report as a self-contained HTML viewer.
For retention debugging, it includes a Memory Decay panel backed by
`/api/decay`, so keep/review/deprecate/expire recommendations, policy horizons,
and first candidates are visible in the same local UI without pruning,
deleting, superseding, or rewriting evidence. `/decay` serves the same
retention plan as a self-contained HTML viewer.
`memory decay --json` adds a read-only retention plan over RedDB graph evidence:
it classifies nodes as keep, review, deprecate, or expire from access overlays,
supersession, contradictions, TTL horizons, and pinned importance without
deleting anything. `memory decay-viewer` writes the same plan as a local HTML
artifact.
For self-improvement debugging, it includes a Learning Debt panel backed by
`/api/learning-debt`, so repeated failure patterns, stale or contradicted
guidance, missing validation evidence, and Skill telemetry gaps are visible
without mutating skills. `/learning-debt` serves the same report as a
self-contained HTML viewer.
For operational health debugging, it includes a Memory Health panel backed by
`/api/memory/health`, so graph stats, vector readiness, stale evidence, Skill
telemetry availability, and recommended next actions are visible without
confusing that report with the server's endpoint-discovery `/api/health`.
`/memory/health` serves the same report as a self-contained HTML viewer.
For layered architecture inspection, it includes a Memory Layers panel backed by
`/api/layers`, so the short-term, long-term, reasoning, docs/code, and vector
layers are visible in the same local cockpit. `/layers` serves the same report
as a self-contained HTML viewer.

For agent interop, `memory routing-guide --agent
codex|claude|cursor|gemini|aider|opencode|generic --json` emits the target
rule file, MCP stdio config shape, loopback HTTP command, hook notes where
supported, CLI fallbacks, and the map-context rule for calling Memory before
broad grep, recursive file reads, or many-file source opens. This is
intentionally a local-dev adoption
surface: every agent points at the same project-local RedDB store through
`memory-mcp`, `memory serve`, or bundled lifecycle hooks rather than a cloud
memory service. `memory routing-guide-viewer --agent <name>` writes the same
contract as a self-contained HTML viewer, `/routing-guide?agent=<name>` serves
it over loopback HTTP, and the Workbench includes an Agent Routing panel backed
by `/api/routing-guide`. The MCP and CLI routing-guide output describes map
context as agent context for choosing the next reads, not as a generated answer.
`memory integration-status --json` audits whether
supported agents have Memory routing snippets and hook coverage in place, while
`memory integration-status-viewer`, `/integration-status`, `/api/integration-status`,
and the Workbench Agent Integration Status panel render the same read-only
status without installing hooks or editing agent rule files.

For cross-agent continuation, `memory handoff [focus]` builds a deterministic
handoff block from graph evidence: active work, recent decisions, validation
evidence, risks, relevant context, and citations. `memory handoff-viewer
[focus]` and `/handoff` render the same `memory.handoff.v1` contract as a
self-contained local HTML handoff, while `/api/handoff` exposes the JSON report
to the Workbench and HTTP agents. It is read-only and does not expose raw
transcripts.

## Storage modes

`memory init` picks one storage mode. Two ship today:

- **markdown-only** — zero engine dependency. Writes the `plugins.memory` block of `.red/config.yaml`
  and `.red/memory/notes/`; `/memory:store` writes a plain markdown note,
  `/memory:recall` full-text-searches the notes.
- **graph** — governed operational memory over a per-project embedded RedDB store
  at `.red/memory/graph.rdb`. `/memory:store` upserts a deduped operational fact;
  `/memory:recall` runs the governed recall engine — deterministic text seeds
  expanded through the graph neighborhood, then passed through a deterministic
  ranking pipeline: query-variant RRF, exponential recency decay, MMR diversity,
  and session round-robin interleaving. Defaults are `rrfK: 60`,
  `recencyHalfLifeDays: 30`, `mmrLambda: 0.72`, `queryVariantLimit: 4`, and
  `sessionRoundRobin: true`; override them sparsely under
  `plugins.memory.recallRanking` in `.red/config.yaml`. The head of any
  `SUPERSEDED_BY` chain is returned in place of superseded nodes
  (`--include-superseded` returns the full chain). Vector projections can
  contribute when explicitly ready, but they are not the source of truth. RedDB runs out-of-process from the
  SDK's bundled binary — no service to manage. Graph writes use multi-model DML
  and KV-backed dedupe; see [ADR 0007](../../.red/adr/0007-reddb-graph-writes-via-multi-model-dml.md).

**markdown-only keeps all hooks off** — nothing can auto-fire, there is no
engine to recall from or index into. **graph mode** can opt into the four
auto-firing hooks below; they default off and are turned on at `memory init`.
The `dev` plugin soft-uses Memory for `/afk`, `/triage`, `/diagnose`, and
`/zoom-out` when it is initialized; absence or failure degrades to the original
workflow instead of becoming a hard dependency.

## Dev workflow participation

Memory is deliberately a soft dependency for the `dev` plugin. Every integration
must treat recalled material as a claim made at store time and verify it against
the current repo before acting on it.

| Dev workflow | How Memory participates | Graceful degradation |
|--------------|-------------------------|----------------------|
| `/afk` | Recalls issue and brief terms before planning so an inner agent can see prior decisions, known dead ends, or successful attempt history. Graph mode can also record terminal AFK attempts as operational evidence for later analysis. | Missing, markdown-only, empty, stale, or failing Memory never blocks the issue; the agent proceeds from the handoff and current files. |
| `/triage` | Recalls issue symptoms and product terms to dedupe against known bugs, shipped decisions, or prior out-of-scope calls before recommending labels. | No hit means only "nothing stored"; triage continues from the issue body, comments, labels, and repo context. |
| `/diagnose` | Recalls previous root causes for the symptom area before hypothesis ranking, then a completed diagnosis can be stored as root-cause history. | If recall is unavailable, diagnosis still follows reproduce -> minimize -> hypothesize -> instrument -> fix -> regression-test. |
| `/zoom-out` | Uses recall and graph reads for map-first orientation, structural impact, and observed AFK attempt history when graph mode is ready. | It remains read-only and falls back to ordinary code exploration; it may recommend `/memory:ingest` only as a future improvement when indexing would materially help. |

## Auto-firing hooks (graph mode, opt-in)

When enabled at init, four hooks let memory work without anyone typing a
command. Each is **gated on the config**: if memory is not initialized, is in
markdown-only mode, or the matching hook flag is off, the hook reads the config
and exits silently — a dormant hook never touches the engine or the turn.

| Hook | Fires on | Does |
|------|----------|------|
| **SessionStart** | session start / resume / `/clear` | recalls memory relevant to the focus (goal/branch/cwd) and injects it as context |
| **PostToolUse** | a file edit (`Edit`/`Write`, or Codex `apply_patch`) | incrementally re-indexes the changed file into the graph |
| **Stop** | end of an assistant turn | extracts structured Problem/Fix/Validation/Decision facts, or decision / why-note fallback memories, and stores them |
| **PreCompact** | before a context compaction / `/clear` where the host exposes that event | flushes ephemeral session knowledge to memory before compaction; unavailable on Codex |

Extraction (Stop / PreCompact) runs through a **bounded-LLM extractor** in
production; with no LLM key configured it falls back to a deterministic
structured-transcript path for explicit `Problem:`, `Fix:`, `Validation:`, and
`Decision:` lines, including `FIXES` / `TESTED_BY` graph edges. When no
structured line is present, hooks still capture cued decision / why-note
sentences. Recall and re-indexing are always zero-token.

### Pointing extraction at a local or in-account model

The `INFERRED` extraction path (`memory extract`, the Stop hook) routes through
whatever you put under `provider` in the `plugins.memory` block of `.red/config.yaml`. Export itself
never needs an LLM — this only governs extraction. For privacy-sensitive
projects where code must not leave your environment, point `provider` at a
local or in-account model:

```jsonc
// Local Ollama (or any OpenAI-compatible server) — inference stays on the box.
"provider": {
  "mode": "openai-compat",
  "model": "llama3.1",
  "baseUrl": "http://localhost:11434/v1"
}

// AWS Bedrock — inference runs in your own AWS account/region.
"provider": {
  "mode": "bedrock",
  "model": "anthropic.claude-3-5-sonnet-20240620-v1:0",
  "region": "us-east-1"
  // Optional: "baseUrl" for a VPC/PrivateLink interface endpoint or on-box proxy.
}
```

`memory extraction status --json` reports the resolved `mode`, `endpoint`, and
an `egress` flag: `local` when the endpoint host is a loopback address (an
Ollama on `localhost`, or a Bedrock proxy bound to the box), `external`
otherwise. Bedrock's regional `bedrock-runtime.<region>.amazonaws.com` host
reads as `external` — traffic leaves the machine but stays inside your AWS
account/region; a loopback `baseUrl` (e.g. a local gateway) reads as `local`.

When `provider` is **absent**, extraction falls back cleanly to the
deterministic structured-transcript path — no provider, no network, no error.
`memory extract --local` forces that same fallback even when a provider is
configured.

### Incremental freshness

For local-first graph freshness without a long-running daemon, graph mode also
ships an explicit incremental refresh command:

```bash
memory refresh src/auth.ts docs/guide.md --root .
memory refresh --changed --root .      # git diff HEAD
memory refresh --staged --root .       # pre-commit friendly
git diff --cached --name-only -z | memory refresh --stdin --root .
```

`refresh` stores a stable per-file content hash in the graph store's KV layer.
Replays of unchanged files skip extraction entirely; changed files are indexed
through the same deterministic code/markdown extractors as `ingest`. Its report
summarizes added, updated, skipped, and stale graph elements. Stale elements are
reported when a changed or deleted file no longer emits graph labels that a
previous refresh saw; they are not pruned automatically.

There is intentionally no filesystem watcher in this first implementation. The
supported freshness paths are hook-only: PostToolUse hooks, explicit
`memory refresh`, and git-hook-compatible `--staged`/`--stdin` invocations. That
keeps the embedded RedDB workflow zero-ops and avoids flaky real-time watcher
behavior in tests and local shells.

### Vector projection

Graph mode keeps a RedDB-native `memory_vectors` projection for graph Memory
nodes, asset metadata nodes, and ingested `memory_docs` chunks. Node vectors can
seed governed hybrid recall; asset hits keep their path/kind/media metadata in
vector diagnostics and smart search; document vectors can seed governed recall
only when the hit maps by document hash to an ingested markdown root node.
Ungrounded document hits remain ASK/readiness substrate.

```bash
memory vector status --root . --json
memory vector status-viewer --root .
memory vector maintain --root . --strict
memory vector search "auth session" --root . --json
memory vector maintain --root . --local --json
memory vector search "auth session" --root . --local --json
```

Projection uses RedDB `WITH AUTO EMBED` when `RED_MEMORY_VECTOR_PROVIDER` is
configured. Without a provider, writes still succeed and vector status reports
the projection as unavailable rather than failing recall. For local development,
`RED_MEMORY_VECTOR_PROVIDER=local` or `--local` stores deterministic hashed
embeddings in the project RedDB KV surface, so vector diagnostics work without a
network provider. After `memory vector maintain --local` has written that
projection once, later `vector status`, `vector search`, capability catalog, and
radar reads can reuse the persisted local projection without repeating
`--local`. `vector search` is a diagnostic read over grounded vector candidates;
governed recall remains the canonical read path for agent context.

### VCS checkpoints

Graph mode can create an explicit RedDB VCS checkpoint for the versioned Memory
graph:

```bash
memory commit --root . --message "manual memory checkpoint"
memory commit --root . --json
```

The command reapplies the Memory tier/versioning policy, reports included and
skipped collections, commits only when the included historical surface changed,
and reports `nothing meaningful to commit` when only skipped transient metadata
changed. Skipped collections include transient KV metadata and the raw
`memory_events` audit log; these are intentionally outside historical recall.

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
context-trim event exists in the Codex hook vocabulary, so
`hooks/codex.hooks.json` intentionally does not contain `PreCompact`. No
Memory config flag can make Codex fire that hook today.

What is lost on Codex: Memory cannot run a last-chance extraction immediately
before `/clear` or host-driven context trimming. Facts that exist only in the
soon-to-be-discarded context, and have not already been captured by a prior
`Stop` hook or explicit `memory store` / `memory extract`, can be lost.

What compensates: Codex still wires `Stop`, so every substantive completed turn
can extract memories before the next turn starts, and it wires `SessionStart`,
so a new session or `/clear` can recall stored context after the reset. Hook
coverage reports this as an effective fallback only when both `Stop` and
`SessionStart` are enabled; otherwise it reports an actionable Codex
`PreCompact` fallback gap.

### Session lifecycle — `.red/memory/sessions/current`

Working-memory layers (L1/L2) scope themselves to a per-worktree session id
written to `.red/memory/sessions/current`. The id is set up by whichever
mechanism fires first:

1. **Claude Code `SessionStart` hook** — mints a fresh UUID (or reuses the
   runner-supplied `session_id`) on session start, resume, and `/clear`.
   Always runs when the manifest is wired, even in markdown-only mode.
2. **Codex / any runner without a wired `SessionStart` hook** — Codex now has
   a `SessionStart` event (see [`reference_codex_hooks`][1] and issue #55), so
   when the manifest is enabled the same path applies. When it is not, the
   first `memory` CLI or MCP call to fire a hook ensures a session: it honours
   `$MEMORY_SESSION_ID` if the harness exports one, otherwise mints a UUID.
3. **AFK worker spawn** — the `/afk` orchestrator writes a fresh UUID into the
   worktree's `.red/memory/sessions/current` immediately after `git worktree
   add`, so each parallel worker starts with an isolated working-memory scope
   even before any hook fires.

Inspect and reset the file from the CLI:

```bash
memory session show     # prints the current id, or "none"
memory session start    # mints + writes a fresh id (idempotent on the file)
memory session end      # drops the file
```

[1]: https://developers.openai.com/codex/hooks

## Graph read verbs (graph mode)

Beyond `recall`, graph mode exposes the read primitives directly — all
zero-token (no LLM). Markdown ingest records headings, wiki-links, inline
identifiers, and explicit Markdown links as graph references. Code ingest records files, symbols, imports, and
conservative intra-file TS/JS `CALLS` / `USES_TYPE` edges so impact queries can
explain call and type relationships as well as dependencies. SQL ingest records
schema files, tables, columns, and foreign-key `REFERENCES` edges from `.sql`
files without connecting to a live database. Dev-workflow ingest also indexes
`package.json` scripts, Dockerfile stages/steps, GitHub Actions jobs/actions,
and shell functions as RedDB graph evidence. Binary corpus assets (`.pdf`,
common image/audio/video formats, and Office docs) are indexed as metadata-only
`file` nodes. Incremental refresh stores a compact
per-file manifest in RedDB KV, chunked for docs with many references, so rich
documentation maps stay refreshable through hooks. Pre-PR review uses graph
edges to flag downstream call/type/reference risks:

```bash
memory search <query>          # full-text node search
memory docs search <query>     # zero-token document chunk search
memory docs search-viewer <query> # local HTML search results viewer
memory docs brief <query>      # cited docs evidence brief with gaps
memory docs brief-viewer <query> # local HTML brief viewer
memory docs bundle <query>     # top docs plus agent-ready evidence packs
memory docs bundle-viewer <query> # local HTML bundle viewer
memory docs read <path|rid>    # read an ingested document chunk
memory docs evidence-pack <path|rid> # agent-ready doc body/references/related pack
memory docs evidence-pack-viewer <path|rid> # local HTML evidence-pack viewer
memory docs backlinks <label|rid> # docs that reference a Memory node
memory docs backlinks-viewer <label|rid> # local HTML backlinks viewer
memory docs related <path|rid> # references and docs with shared references
memory docs related-viewer <path|rid> # local HTML related-docs viewer
memory docs restore [path|rid] --dry-run # plan file restore from RedDB docs
memory docs restore [path|rid] --in-place --yes # explicitly rewrite missing docs
memory docs coverage           # graph/vector coverage for docs
memory docs coverage-viewer    # local HTML coverage dashboard
memory docs reference-graph    # docs-to-reference graph report
memory docs reference-graph-viewer # local HTML docs graph viewer
memory assets --json           # binary/media asset inventory
memory assets-viewer           # local HTML asset inventory
memory bootstrap --dry-run     # discover seed docs before indexing
memory backup create --name before-change # local RedDB snapshot
memory backup restore before-change --yes # explicit restore with safety backup
memory serve --token-env MEMORY_HTTP_TOKEN # optional local HTTP UI/API
memory smart-search "auth session" --json # recall + docs + assets + vectors
memory smart-search-viewer "auth session" # local HTML smart-search viewer
memory context-pack-viewer "auth session" # local HTML context-pack viewer
memory capabilities --json     # capability catalog by agent surface
memory layers --json           # short-term/durable/reasoning/docs-code/vector layers
memory layers-viewer           # local HTML layered architecture viewer
memory frontier --json         # ready/blocked work frontier
memory frontier-viewer         # local HTML work frontier viewer
memory lint --json             # hygiene findings + rule suggestions
memory decay --json            # keep/review/deprecate/expire retention plan
memory decay-viewer            # local HTML decay plan viewer
memory governance --json       # provenance/privacy/lint/conflict governance report
memory governance-viewer       # local HTML governance viewer
memory learning-debt-viewer    # local HTML self-improvement debt viewer
memory health-viewer           # local HTML operational health viewer
memory onboarding-map-viewer   # local HTML map-first onboarding viewer
memory communities-viewer      # local HTML graph community analytics viewer
memory references-radar --json # internal reference posture from catalog evidence
benchmark-memory references eval         # human-readable composite + per-dimension summary
benchmark-memory references eval --json  # machine-readable reference eval report
benchmark-memory references viewer       # local HTML reference eval viewer (default: .red/memory/reference-eval.html)
memory workbench               # local unified Memory UI
memory routing-guide --agent cursor --json # multi-agent MCP/HTTP integration guide
memory routing-guide-viewer --agent cursor # local HTML multi-agent routing guide
memory integration-status --json # audit agent rule files and hook coverage
memory integration-status-viewer # local HTML integration status
memory extraction status --json # deterministic/inferred extraction readiness
memory extraction status-viewer # local HTML extraction readiness viewer
memory extract transcript.md --local # provider-free structured transcript extraction
memory session timeline --json  # replay-style hook/skill event timeline
memory session timeline-viewer  # local HTML timeline viewer
memory handoff "auth work"     # cross-agent continuation brief
memory handoff-viewer "auth work" # local HTML cross-agent handoff
memory dashboard               # local operational dashboard
memory routing-guide --agent codex
memory neighbors <label>       # 1-hop neighborhood
memory traverse <label>        # BFS/DFS walk
memory path <from> <to>        # shortest path
memory path-explain <from> <to> --json
memory path-explain-viewer <from> <to>
memory structural-impact-viewer --file src/auth.ts
memory pre-pr-review-viewer --range HEAD
memory ask "what changed about auth?" --json # cited answer + gap analysis
memory conflicts               # unresolved CONTRADICTS edges
memory supersede <old> <new> --reason "policy changed"
memory resolve-conflict <active> <superseded>
memory timeline <topic> --include-audit
memory stats                   # node/edge counts
```

Contradiction and supersession commands never delete old guidance. `supersede`
and `resolve-conflict` add `SUPERSEDED_BY` audit edges with an optional reason;
normal recall promotes the active head of the chain, while `recall
--include-superseded`, `conflicts --include-resolved`, and `timeline
--include-audit` preserve the full audit history.

## Reference baseline

`benchmark-memory` carries a checked-in reference eval harness so the README comparison
is backed by executable assertions instead of marketing copy:

```bash
pnpm --filter @reddb-io/benchmark-memory references:eval
pnpm --filter @reddb-io/benchmark-memory references:interop
pnpm --filter @reddb-io/benchmark-memory references:baseline
pnpm --dir apps/plugin-memory test -- competitive-baseline
```

`references:eval` runs entirely against checked-in fixtures and emits JSON plus
a human-readable report. The fixture currently measures recall quality/latency,
context-pack size reduction, candidate-memory classification, lint policy
findings, and claim guards for live-service references. A representative local
run reports recall@k `1`, p50 recall latency under `2 ms`, context-pack size
reduction around `0.59`, classification accuracy `1`, policy findings for
imperative memories / likely secrets / stale progress, and no unsupported live
reference claims. Latency is machine-local, so CI should compare the JSON
shape and thresholds rather than treating the exact milliseconds as a public
benchmark.

Executable public claims are listed in
`src/competitive-fixtures.ts` and checked by `references:eval:v2`. README copy
should cite these evidence IDs when it makes a public comparison or product
claim:

| Public claim ID | README claim | Executable evidence IDs |
|-----------------|--------------|-------------------------|
| `checked-fixture-retrieval` | The reference eval reports retrieval quality from checked-in fixtures. | `dimension:retrieval`, `fixture:recall` |
| `readiness-envelope-consumer` | The readiness envelope is available for `references:eval:v2` consumers. | `dimension:readiness`, `foundation:readiness-envelope` |
| `session-lifecycle-comparison` | Memory has native agent session lifecycle integration in the comparison table. | `baseline:memory-lifecycle-beats-agent-memory` |
| `operator-surface-dashboard` | The reference eval measures docs, hooks, dashboard, and capability catalog operator surfaces. | `dimension:operator-surface`, `foundation:doc-coverage`, `foundation:hook-coverage`, `foundation:operational-dashboard`, `foundation:capability-catalog` |
| `multi-agent-integration-status` | The reference eval measures multi-agent Memory routing and integration status across supported coding agents. | `dimension:multi-agent-integration`, `foundation:routing-guide`, `foundation:agent-integration-status`, `foundation:mcp-agent-tools`, `foundation:hook-backed-agent-integration` |
| `intelligent-memory-five-surfaces` | Memory is intelligent: composed confidence, reasoning-replay, federation, what-if, and autocure each ship as a measured surface (#173). | `dimension:intelligence`, `foundation:confidence-scoring`, `foundation:reasoning-replay`, `foundation:federation`, `foundation:whatif`, `foundation:autocure` |
| `governed-cross-agent-smoke` | The 60-second Memory story uses a governed write surface to store source-cited validation evidence as one runner and recall it with provenance as another. | `dimension:governed-write`, `foundation:governed-write-cli`, `foundation:cross-agent-governed-recall`, `foundation:mistake-avoided-bench` |

The same guard intentionally leaves live-service reference wins unclaimed
unless the required live baseline is measured. In particular, the checked-in
fixture may compare against `graphify-out` path latency, but it does not claim a
latency win over `neo4j-labs/agent-memory` without an opt-in live Neo4j
baseline.

`references:eval:v2` can also opt in to a live `rohitg00/agentmemory` CLI
baseline without making normal tests or fixture runs depend on Agentmemory:

```bash
MEMORY_AGENTMEMORY_BASELINE_CMD='["node","scripts/agentmemory-baseline.mjs"]' \
  pnpm --filter @reddb-io/benchmark-memory dev -- references eval --v2 --json --human --live-agentmemory
```

The same harness can opt in to a `neo4j-labs/agent-memory` recall-latency
baseline when a local wrapper for the Neo4j-backed service is available:

```bash
MEMORY_NEO4J_AGENT_MEMORY_BASELINE_CMD='["node","scripts/neo4j-agent-memory-baseline.mjs"]' \
  pnpm --filter @reddb-io/benchmark-memory dev -- references eval --v2 --json --human --live-agent-memory
```

The configured commands are local wrappers around the available reference
install or service. They must print JSON with optional `summary`, numeric
`metrics`, and string `evidence` fields. Missing commands are reported as
unavailable live baselines, not as fixture failures.

`references:interop` also runs entirely against checked-in fixtures. It emits
JSON and a human-readable mapping report for Graphify-like and
Neo4j-agent-memory-like artifact shapes, including preserved, approximated, and
dropped concepts. The report is intentionally limited to fixture interop and
does not claim full Graphify, Neo4j, Cypher, or live-service parity.

The fixture summary comes from the existing `reddb-benchmark/graphify-out`
run: 551 nodes, 1329 edges, 34 detected communities, 491 inferred edges, and
zero reported input/output tokens. The harness encodes measurable "better than"
claims for embedded footprint, session lifecycle integration, and the repo's
recall-latency budget. It deliberately does **not** claim an apples-to-apples
latency win over `neo4j-labs/agent-memory`; that comparison needs a live Neo4j
baseline and is reported as unmeasured by the claim guard.

| Axis | `memory` | `graphify` | `agent-memory` | Framing |
|------|----------|------------|----------------|---------|
| Zero-ops / embedded footprint | Embedded RedDB file store; no daemon to administer. | Python CLI plus checked-in `graphify-out`; no database daemon, but a separate toolchain. | Neo4j-backed SDK/MCP; needs a Neo4j instance or hosted service. | Advantage: embedded RedDB store, no Python or Neo4j service. |
| Session lifecycle integration | Native SessionStart, PostToolUse, Stop, and PreCompact hooks in graph mode. | Assistant instructions and optional search nudges; not a memory lifecycle. | SDK/MCP integration; no RedSkills hook lifecycle. | Advantage: memory is built into the agent session lifecycle. |
| Engine feature breadth | TTL, KV/cache overlays, native Louvain, ASK; geospatial is not exposed by memory yet. | Static graph export with query/path/explain and 34 detected communities in the fixture. | Neo4j graph, vector/text search, geospatial, MCP tools, eval harness, and framework adapters. | Parity/mixed: both graph competitors have useful breadth; memory wins embedded RedDB primitives, agent-memory wins Neo4j ecosystem breadth. |
| Recall latency on agent-scale graph | Repo gate targets <100 ms p50 on a ~1k-node graph. | graphify-out fixture: 551 nodes / 1329 edges / 34 communities; path p50 841 ms. | Not asserted here; apples-to-apples latency requires a live Neo4j baseline. | Advantage over checked graphify-out path latency only; no latency claim against agent-memory in this harness. |
| NER extraction quality | Deterministic structural/entity extractors plus optional LLM provider for inferred facts. | 491 inferred fixture edges; strong static-code graph output. | spaCy / GLiNER / GLiREL / LLM extraction pipeline. | Conceded gap: Python ML stack is ahead for turnkey NER. |

## Structured eval bench

`benchmark-memory bench eval` runs a checked-in deterministic QA corpus through
RedDB governed recall, markdown embedding-RAG, Neo4j term traversal, and a
Graphify-style adapter. The default corpus
(`apps/plugin-memory/bench/eval/structured/`) reports aggregate scores plus
per-category rows for `single-hop`, `multi-hop`, `temporal-as-of`, and
`unanswerable`.

Temporal questions carry `as_of` timestamps over superseded decisions. RedDB
filters by valid time before ranking; the plain Neo4j fixture intentionally has
no valid-time filter, so the temporal category exposes the as-of reasoning gap.
Unanswerable questions score `not in memory` as the correct answer: correct
abstention receives a positive abstention score, while plausible but unsupported
answers receive a negative score.

```bash
benchmark-memory bench eval \
  --records plugins/memory/bench/results/<date>-eval.jsonl \
  --report plugins/memory/bench/results/<date>-eval.md
```

## Recall-quality bench (vs AMS)

`memory bench recall` runs a checked-in labeled operational corpus through our
RRF recall (keyword + vector + typed-graph) and a pure-vector AMS reference,
reporting `precision@k` and `recall@k` at `k ∈ {1, 5, 10}`. The corpus
(`plugins/memory/bench/recall/`) emphasises decisions, fixes, gotchas, and
reasoning chains where typed-graph signals should beat blind vector search.

```bash
memory bench recall \
  --out plugins/memory/bench/results/<date>-recall.json \
  --report plugins/memory/bench/results/<date>-recall.md
```

The bench is fully in-process and deterministic — same corpus + queries on the
same git ref yields byte-equal results (the test suite asserts this with zero
tolerance). Latest results: [`bench/results/2026-05-26-recall.md`](./bench/results/2026-05-26-recall.md).

## Hot-read latency bench (vs AMS)

`memory bench latency` measures p50 / p95 / p99 / p99.9 of three hot-read op
classes — `working-get`, `session-recall`, `long-term-recall` — against our
in-process L1/L2 cache path and an AMS-on-Redis reference path (JSON parse per
response, client-side fan-out for graph hops). Workload is seeded
(`mulberry32`); both paths do only real CPU work, no artificial sleeps.

```bash
memory bench latency \
  --out plugins/memory/bench/results/<date>-latency.json \
  --report plugins/memory/bench/results/<date>-latency.md
```

Workload shape and tolerance live in
[`bench/latency/README.md`](./bench/latency/README.md). The test suite asserts
the architectural invariant (`p99(ams) >= p99(ours)`) rather than absolute
numbers, because wall-clock percentiles vary with host noise. Latest results:
[`bench/results/2026-05-26-latency.md`](./bench/results/2026-05-26-latency.md).

## Readiness envelope

`memory readiness <goal> --json` emits the stable `memory.readiness.v1`
envelope for future UI and `references:eval:v2` consumers. The envelope
combines task preflight evidence, vector projection status, provenance,
supersession, contradictions, privacy and claim-check summaries, RedDB
VCS/time-travel collection status, event-log telemetry, and graph community
signals from the current Memory graph.

## Maintenance & export (graph mode)

```bash
memory doctor                  # list stale nodes
memory doctor --prune          # prune (confirms first)
memory export [<out-dir>]      # graph.json + graph.html + audit.md
memory export [<out-dir>] --interop # + JSONL, GraphML, Neo4j Cypher
```

`doctor` flags nodes unaccessed for 90+ days (`--stale-days N` to change) that
have never been recalled, and prunes them **only after explicit confirmation** —
never automatically. Pinned nodes (`importance >= 0.8`) are exempt. Recall bumps
each hit's access counter, so frequently-recalled nodes stay fresh.

`export` writes a self-contained, navigable `graph.html` (data inlined, opens
from disk — no server) alongside `graph.json` and a health-summary `audit.md`.
The bundle includes node/edge evidence, document metadata, vector-projection
readiness for nodes and docs, health panels, contradictions, supersession, stale
evidence, and a small context-pack preview. It deliberately exports document
metadata and body lengths rather than full document bodies.
With `--interop`, the same read-only export also writes `nodes.jsonl`,
`edges.jsonl`, `graph.graphml`, and `neo4j.cypher` for GraphML/Neo4j-style
exchange. These artifacts are portable views; the project-local RedDB graph
remains the source of truth.

`memory docs restore [path|rid]` is the explicit restore-only path for
documentation stored in RedDB. Without `--yes` it plans the restore; with
`--yes` it writes either to `.red/memory/restored-docs`, a caller-provided
`--out <dir>`, or the original in-repo path with `--in-place`. Existing files
are not replaced unless `--overwrite` is passed.


## Self-improvement loop

Skill telemetry can drive a reviewable improvement workflow without letting the
agent silently rewrite its own instructions:

```bash
memory health --json
memory hooks coverage --json
memory hooks coverage-viewer
memory improve skills --write-proposal --json
memory improve proposals list --json
memory improve proposals show .red/memory/proposals/<proposal>.md --json
memory improve apply .red/memory/proposals/<proposal>.md --yes --json
memory improve proposals archive .red/memory/proposals/<proposal>.md --reason applied --yes --json
```

`hooks coverage` is read-only: it reports Claude/Codex manifest wiring,
config-enabled lifecycle hooks, effective fallback coverage, actionable gaps,
and known runner differences such as Codex lacking `PreCompact` without turning
hooks on.
`hooks coverage-viewer` writes the same report as embedded JSON plus HTML for
local inspection and MCP/HTTP handoff.

Proposals live under `.red/memory/proposals/`. Each Evidence card has a deterministic fingerprint from telemetry source, refinement route, dominant error pattern, and telemetry window. Repeated generation refreshes matching unresolved cards in `captured`, `routed`, or `proposed` status instead of creating duplicate files; reviewed or terminal cards are preserved and the next run creates a new card. Draft structured patches prefer semantic section anchors derived from the dominant failure stage/class before falling back to a safe tail anchor. Archiving moves reviewed files to
`.red/memory/proposals/archive/<applied|rejected|stale>/`, so `memory health`
counts only actionable pending proposals while retaining audit history.

Skill telemetry also dual-writes raw `skill.telemetry` records to the
append-only Memory event log (`memory_events`). Existing rollups remain the
serving path for status, curation, and recommendations; the event log is the
raw audit substrate for future readiness and self-improvement views. Raw event
readers apply a configurable retention horizon: graph init defaults to 30 days,
and `memory init --mode graph --event-retention-days N` writes a different
project horizon into the `plugins.memory` block of `.red/config.yaml`. The `memory_events` collection
is always non-versioned and skipped by `memory commit`; promoted durable or
reasoning graph evidence, rollups, and recallable facts survive even when old
raw operational events age out of event-log reads.

## MCP server

`memory-mcp` speaks MCP over stdio and exposes the same surface to agents:
`memory_recall`, `memory_store`, `memory_search`, `memory_traverse`,
`memory_neighbors`, `memory_path`, `memory_ask`, `memory_export`,
`memory_doctor`, `memory_stats`, `memory_conflicts`, `memory_timeline`,
`memory_supersede`, plus registry-backed read-only tools for readiness,
readiness viewer HTML, operational dashboard HTML, unified workbench HTML, structural impact viewer HTML, pre-PR review viewer HTML,
context packs and context pack viewer HTML, work frontiers and work frontier viewer HTML, handoff briefs and handoff viewer HTML, session timelines and session timeline viewer HTML, document search/read/coverage, doc coverage viewer HTML, path explanations and path explanation viewer HTML, pre-PR reviews, multi-agent routing guides for Codex/Claude/Cursor/Gemini/Aider/OpenCode/generic MCP or HTTP agents, claim checks,
agent integration status and agent integration status viewer HTML, provenance, privacy, governance and governance viewer HTML, lint, decay plans and decay viewer HTML, skill recommendations, learning debt and learning debt viewer HTML, health and health viewer HTML,
capability catalogs, memory layers, references radar, hook coverage, communities, onboarding maps, structural impact,
extraction status, vector search diagnostics, and vector projection status.
`memory_recall` returns a
ready-to-inject markdown context block plus ranked nodes; `memory_ask` is the
one LLM-backed verb (it needs an engine API key and degrades gracefully without
one).

### Tier-aware verbs (agents)

The CLI stays tier-agnostic for humans (`memory store` / `memory recall` route
through the layer router). Agents that need precision can drive the memory
tiers explicitly through MCP:

| Tool | Purpose |
|------|---------|
| `memory_session_start` | Mint and write a new session id to `.red/memory/sessions/current`. Optional `id` reuses a runner-supplied value (e.g. a SessionStart payload). |
| `memory_session_end`   | Drop the session file. After this, working-memory and promote calls error until a new session is minted. |
| `memory_working_get`   | Read typed L2 events for the current session (oldest first). Optional `type` filter. |
| `memory_working_set`   | Append a typed L2 event (`type`, `value`). Crossing the L2 overflow threshold may trigger a promotion pass as a backstop. |
| `memory_promote`       | Run the PromotionEngine for the current session against L3. Returns `(promoted, reinforced, skipped)` plus rids. |

Working-memory and promote verbs require an active session. Calls without one
error with `"no active memory session — call memory_session_start first (or
rely on the SessionStart hook to mint one)"` so the agent can self-correct
without a human in the loop.

It resolves its store from the project config (the `plugins.memory` block of `.red/config.yaml` in the
cwd or `$MEMORY_ROOT`, graph mode required), or from an explicit
`RED_MEMORY_URI`:

```bash
memory-mcp          # reads ./.red/config.yaml (plugins.memory)
RED_MEMORY_URI=file:///abs/graph.rdb \
  memory-mcp        # explicit store
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
| **[improve-skills](./skills/core/improve-skills/SKILL.md)** | Generate approval-gated Skill improvement proposals from telemetry and apply reviewed structured patches only with explicit `--yes`. |
| **[health](./skills/core/health/SKILL.md)** | Report operational Memory health: graph readiness, freshness, telemetry rollups, ranked candidates, pending proposals, and next actions. |
| **[context-status](./skills/core/context-status/SKILL.md)** | Report context stack readiness across agent rules, domain docs, ADRs, Memory graph/freshness/telemetry, Wiki, score, and recommendations. |
| **[doctor](./skills/core/doctor/SKILL.md)** | Flag stale nodes and prune them after confirmation (graph mode). |
| **[export](./skills/core/export/SKILL.md)** | Export the graph to a navigable graph.html + graph.json + audit.md (graph mode). |
| **[wiki-init](./skills/core/wiki-init/SKILL.md)** | Bootstrap the LLM Wiki in a repo: scaffold `.red/wiki/`, `.red/agents/wiki.md`, gitignore artefacts, register under `## Agent skills` in CLAUDE.md. |
| **[wiki](./skills/core/wiki/SKILL.md)** | Wiki operations: `ingest` (URL or file drop), `query` (md/tables/Mermaid, optionally file-back), and `lint` (contradictions, orphans, stale, gaps). |

## Build

The plugin ships **source only**; `dist/` and `node_modules/` are gitignored and
built on your machine at init time (needs only node + pnpm):

```bash
pnpm --dir apps/plugin-memory install
pnpm --dir apps/plugin-memory build
```

Then drive it directly if you like (swap `--mode graph` for the graph store):

```bash
memory init --mode markdown-only
memory store the cache TTL is 300 seconds
memory recall cache TTL
```

`graph` mode needs the install step above (it pulls `@reddb-io/sdk` and its
bundled `red` binary); markdown-only needs only node.

## Develop

```bash
pnpm --dir apps/plugin-memory test              # fast, deterministic vitest gate
pnpm --dir apps/plugin-memory test:integration  # heavy RedDB real-server / CLI suite
pnpm --dir apps/plugin-memory typecheck         # tsc --noEmit
pnpm --dir apps/plugin-memory build             # tsc → dist/
```

`test` is the AFK feedback gate: in-process tests only, run with file
parallelism so it stays well under the AFK timeout. The process-spawning
real-server / real-CLI tests and the latency benchmark live in the
`test:integration` project (see `vitest.suites.ts`) — run them explicitly or in
CI, not in the AFK loop, since they flake under CPU contention.

The TS workspace is self-contained under `plugins/memory/`; the red-skills root
stays build-free.

## License

Apache-2.0. See the repo [LICENSE](../../LICENSE) and [NOTICE](../../NOTICE).
