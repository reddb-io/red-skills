# 0005 — Memory plugin: three-layer RedDB architecture, local-first per-repo, MCP+CLI without REST

## Status

accepted.

## Context

The `memory` plugin (`plugins/memory/`) gives Claude / Codex / AFK agents
durable per-project memory. Today it ships markdown-only and graph modes over
RedDB, with provenance, supersession, claim-check, readiness, context-pack,
Skill telemetry, and MCP read tools — embedded per repo, no server.

Redis recently published [`agent-memory-server`](https://github.com/redis/agent-memory-server) (AMS):
a hosted REST + MCP service with two tiers (`working_memory` / `long_term_memory`),
hybrid search over Redis vector, LiteLLM-backed extraction and summarization,
and a Python SDK. AMS is the visible benchmark in this space and the comparison
users will make.

This ADR records the shape we picked to be *better than AMS for the
local-per-repo code-agent case* — not to compete as a hosted memory service.
Each decision below was the result of a `/start` grilling session
(2026-05-25/26) and chose against at least one viable alternative.

## Amendment (2026-08-19, ADR 0152, issue #4027)

**Decision 1 said "local-first per-repo"; the repo it meant is now the
Project, and the process that opens it is the daemon.** Decision 1's positioning
survives whole — no multi-tenancy, no `tenant`/auth axis, no hosted service —
but two of its unstated assumptions did not: that a memory store belongs to a
CHECKOUT, and that the process asking is standing in one.

Neither holds since ADR 0149 put Workers in daemon-placed workspaces. A Worker
has no repository checkout to open, so "the memory of the repo I am in" stopped
naming one thing, and ADR 0144 §5 had already refused the client checkout as a
daemon input.

So, per ADR 0152:

- The default root is `~/.red/memory/<project-id>`, keyed by the Project's
  GitHub identity, which survives a clone, a move and a rename. One store per
  Project per host, held by **redskilled**.
- A repository may opt in through `plugins.memory.store: checkout` in its
  `.red/config.yaml` to keep memory in its own `./.red/memory` — an operator who
  wants their notes committable is entitled to that.
- The daemon opens the checkout store only for the **interactive** and
  **ADR-editing** modes (ADR 0150 §1). A caller exporting `RED_MODE` is a
  Worker, and a Worker never reaches the human's checkout.
- Decision 3's identity `(repo, session_id)` reads as `(Project, session_id)`.
  What changed is which directory answers "repo", not that scope is per-Project.

The MCP surface named in this ADR is now `rs_memory`, a thin adapter that
publishes schemas and forwards (ADR 0147 rule 2); it holds no RedDB.

## Decisions

### 1. Positioning — local-first per-repo, not a hosted service

No multi-tenancy, no `tenant`/auth axis. The product is a per-repo memory
plugin (and an optional **localhost** convenience server for local agents).
AMS users migrate via a one-shot offline importer, not wire compatibility.

Rejected: full drop-in REST + MCP parity with AMS.

### 2. Three storage layers

A new term **Memory layer** (added to `.red/contexts/memory/CONTEXT.md`),
orthogonal to the existing **Memory tier** (retention class):

- **L1** — in-process hot, per-agent turn. Ephemeral.
- **L2** — RedDB session-scoped, TTL + size eviction (Q13-d). Survives `/clear`.
- **L3** — RedDB graph, durable. Governed by `memory doctor`.

API edges may expose AMS-compatible `working_memory` / `long_term_memory`
*names* (L1+L2 = working, L3 = long-term) for the importer and porting guide,
but the engine is three-layer.

Storage schema: **one graph, `layer` as a node attribute** (Q20-a). All writes
go through RedDB; RedDB's own L1/L2 cache hierarchy absorbs hot-path cost.

Rejected: AMS's two-tier model verbatim; separate-namespace-per-layer; in-process
L1 carve-out outside RedDB.

### 3. Scope — repo + session, no `user_id`

Identity is `(repo, session_id)`. No `user_id`, no `tenant`, no `namespace`.

`session_id` is **hook-minted** on `SessionStart` (Claude) into
`.red/memory/sessions/current`; Codex (no `SessionStart` equivalent, gap noted
in memory `reference_codex_hooks`) falls back to harness env or first-call
mint. AFK workers mint their own session per worktree.

### 4. Concurrency and conflicts

Per-session L1/L2 isolation. L3 writes serialize through RedDB transactions.
On contradictory writes from independent sessions, the engine creates a
`conflicts-with` edge and surfaces in `claim-check` / `readiness`. Supersession
is not silent — this is the one engine behavior AMS does not have, and the
concrete answer to "better than Redis."

Rejected: last-write-wins.

### 5. Pure-RedDB hybrid search

RedDB has native HNSW / IVF / quantization / SIMD / tiered-search and a graph
engine; vectors live in the existing `memory_vectors` projection. No vector
sidecar, ever (Q06).

Recall scoring: emit a hybrid query to RedDB's tiered-search (which auto-routes
Flat/HNSW/IVF+rerank and fuses vector + keyword + metadata), then fold typed
graph-traversal distance into the fused ranking via **Reciprocal Rank Fusion**.
No hand-tuned weights.

### 6. Extraction — one configurable extractor, typed schemas

Single `extract` strategy with a typed output schema; defaults map to the
existing operational typology (Decision / Problem / Fix / Validation / Gotcha /
Reasoning), plus `summary` and `preferences` schemas for AMS parity.

LLM and embedding calls go through **RedDB's `red.config.ai.provider`** layer
(`openai-native`, `anthropic-native`, `openai-compat`, `bedrock`). The memory
plugin does not import LLM SDKs.

Rejected: hard-coded AMS strategy enum; LiteLLM dep; bring-your-own-client.

### 7. Promotion (L2 → L3)

Triggers (Q09-d, layered):

- Explicit `promote` / `extract` call.
- Lifecycle hook: `PreCompact` / `SessionEnd` / `Stop` (richer on Claude).
- L2 overflow backstop (token/byte budget) — covers Codex sessions without
  `PreCompact`.

Gate (Q23-d): **type + dedup against L3**. Typed candidates promote unless they
already exist (semantic + keyword match); existing L3 nodes get a
`reinforced` bump. No confidence threshold — supersession + `memory doctor`
handle the long tail.

### 8. Working-memory shape

Typed event stream (`user_input`, `agent_action`, `tool_call`, `tool_result`,
`decision_candidate`, `gotcha_candidate`, …) as the source of truth, plus a
raw transcript blob in L2 as the safety net for late re-extraction (Q12-c).

### 9. AFK lifecycle

On AFK session end (worktree merge): **promote-all** remaining typed
candidates, archive the raw transcript blob to L3 as a `worktree:<id>`
artifact, then drop L2. Nothing valuable dies silently; re-extraction is a
query on the archive, not a race against TTL.

### 10. Federation

Today: **L3 read-only** across repos (matches the `cross-root read (no policy
yet)` work just landed in `f3b0ba8` / `5ba9054` / `fa1f0c0`).

Next, after policy lands: cross-repo **supersession edges** (a session in repo
A may mark a decision in repo B as superseded — the edge crosses, the content
does not). L1/L2 never federate; cross-repo writes stay out of scope.

### 11. Surface — MCP + CLI, no REST

CLI is tier-agnostic for humans (`/memory:store "Decision: …"` just works);
MCP exposes tier-aware verbs for agents (`session start|end`, `working
get|set`, `promote`). Migration from AMS is **offline only**: `memory import
ams dump.json` + a porting guide listing the AMS features we do not have
(hosted multi-tenant, REST wire compat).

Rejected: REST server (in any form); live AMS shadow-read; AMS-compat mode.

### 12. Observability

Pino logs (`@tetis-lair/tetis-logger`) for runtime, **RedDB events stream**
(`mem.events`) for in-product queries (`memory health`, conflict counts, recall
hit rate). OTel spans are deferred until we publish public p99 numbers.

### 13. Benchmarking — falsifiable "better than"

Extend `competitive-baseline` to publish three axes against AMS:

- **Latency** at p50/p99 on hot reads (working-memory get, recent-session recall).
- **Recall quality** (precision@k, recall@k) on a labeled corpus of agent transcripts + queries.
- **End-to-end task success** of an agent (Claude or Codex) on a fixed suite, AMS-backed memory vs ours.

`bench/` runs all three, gates releases, publishes results.

## Why

- **One unified backend (RedDB)** is the architectural bet of this stack;
  sidecars and Python deps (LiteLLM) would betray it.
- **Local-first per-repo** matches how Claude Code / Codex / AFK actually run;
  the hosted-service shape AMS adopted is for a different audience.
- **Governance (provenance, supersession, conflict edges, type+dedup
  promotion)** is the one axis where AMS structurally cannot match us without
  a redesign — so we lean into it instead of chasing parity on hybrid search
  alone.
- **No REST** keeps the surface area sized to what agents (MCP) and humans
  (CLI) actually use; every endpoint we don't ship is a contract we don't
  freeze.

## Consequences

**Gain**

- One DB, one provider layer, one process model — fewer moving parts than AMS.
- Concurrency story (supersession across sessions) AMS does not have.
- Per-repo isolation by construction; no auth/quota to engineer.

**Lose**

- AMS users cannot point a client at us and have it work; they must run the
  offline importer.
- Hosted/multi-tenant deployments are out of scope.
- LiteLLM's long-tail provider coverage is out of scope unless RedDB's
  `openai-compat` mode covers the target.

**Future work**

- **Policy** for federation, enabling cross-repo supersession edges (Q15-c).
- **OTel** instrumentation when public benchmarks demand p99 attribution
  (Q22-d).
- **AMS importer** format details, embedding-model defaults, concrete TTL /
  RRF-k numbers — tuning that lives in config defaults and follow-up ADRs as
  needed.
