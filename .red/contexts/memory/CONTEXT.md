# RedSkills Memory

The `memory` context names persistent project memory, graph-backed reasoning
evidence, skill telemetry evidence, and the RedDB substrate used by engineering
workflows.

## Language

**Memory plugin**:
The RedSkills plugin that gives agents persistent, queryable per-project memory.
_Avoid_: memory skill, harness memory, personal fact store, Brain interface

**Operational evidence**:
A durable fact about agent work, validation, decisions, risks, attempts, or codebase reasoning that can improve future agent execution.
_Avoid_: personal knowledge, freeform dump, second brain note

**Evidence card**:
A YAML review unit distilled from one or more raw signals, carrying source, cited evidence, proposed lesson, confidence, privacy posture, routing target, and blast radius before any durable Memory or Skill proposal is written.
_Avoid_: raw transcript, proposal file, JSON inbox item, unstructured inbox note

**Evidence card contract**:
The experimental versioned YAML schema for **Evidence cards**, initially `memory.evidence_card.experimental.v0`, intended to migrate to a stable v1 after real refinement sources validate the shape.
_Avoid_: public stable API, ad hoc YAML, unversioned inbox format

**Evidence card source**:
The structured source block on an **Evidence card**; for Skill telemetry it records source kind, runner, Skill identity, rollup reference, and recent event references.
_Avoid_: prose-only source, path-only source, raw event dump

**Evidence citation**:
A short redacted excerpt plus a stable pointer from an **Evidence card** back to its source signal, such as a Memory event, reasoning attempt, validation node, file location, or explicit user feedback record.
_Avoid_: full transcript, raw stdout, unsupported summary

**Evidence card status**:
The lifecycle state of an **Evidence card**: `captured`, `routed`, `proposed`, `approved`, `rejected`, `promoted`, or `archived`.
_Avoid_: quarantine-only status, issue status, proposal archive reason

**Two-stage refinement review**:
The human review pattern where approving an **Evidence card** validates the interpretation of evidence, while approving the resulting proposal validates the concrete Memory, context, issue/PRD, or Skill change.
_Avoid_: one-click mutation, evidence-free diff review, automatic apply

**Evidence review CLI**:
The first operator surface for listing, inspecting, routing, approving, rejecting, promoting, and archiving **Evidence cards**.
_Avoid_: primary Workbench workflow, GitHub-only review, hidden hook action

**Evidence inbox**:
The `.red/memory/inbox/evidence/` review queue where YAML **Evidence cards** live before promotion, archiving, or proposal review.
_Avoid_: root evidence folder, mixed JSON inbox item, proposal directory

**Evidence card fingerprint**:
The deterministic identity for refreshing an unresolved **Evidence card** from the same source, route, dominant error pattern, and telemetry window without overwriting reviewed cards.
_Avoid_: timestamp-only id, duplicate pending card, rewriting approved evidence

**Skill improvement proposal**:
An approval-gated patch proposal for an existing Skill, produced from **Evidence cards** or Skill telemetry while preserving the structured `memory-skill-patch` review/apply contract.
_Avoid_: direct Skill rewrite, new Skill generation, telemetry-only patch

**Skill telemetry evidence card**:
An **Evidence card** distilled from Skill telemetry rollups and recent failure events before `memory improve skills` writes a **Skill improvement proposal**.
_Avoid_: direct telemetry proposal, failure counter only, unreviewed patch trigger

**Evidence tracer-bullet proof**:
The minimum validation for the first **Skill telemetry evidence card** slice: telemetry creates YAML card plus proposal, JSON output stays compatible, fingerprint refreshes unresolved cards, redaction happens before persistence, approve/reject works, and card/proposal links are bidirectional.
_Avoid_: viewer-only demo, untested YAML shape, proposal-only test

**Evidence-linked proposal**:
A proposal artifact that cites the **Evidence card** it came from, preserving traceability while keeping the existing proposal review/apply gate.
_Avoid_: new orphan refinement proposal, cardless patch, duplicated evidence blob

**Evidence proposal link**:
The bidirectional trace between an **Evidence card** and a proposal artifact: the card records the proposal path, and the proposal records the card id or path.
_Avoid_: one-way pointer, filename convention only, copied raw evidence

**Evidence card redaction**:
The privacy step that scans and redacts sensitive content before an **Evidence card** is persisted, while preserving privacy findings for review.
_Avoid_: persist-then-redact, secret marker only, raw transcript storage

**Context update proposal**:
An approval-gated proposal to change Red context glossary language, produced from an **Evidence card** but not applied directly by the refinement loop.
_Avoid_: direct context rewrite, hidden glossary mutation, automatic ADR

**Hermes-like refinement loop**:
A governed Memory workflow inspired by Hermes-style self-improvement, where captured signals become routed evidence and approval-gated proposals rather than automatic Skill creation or silent instruction rewrites.
_Avoid_: Hermes runner, automatic skill factory, self-rewriting agent

**Internal refinement signal**:
A Memory-visible agent signal, such as Skill telemetry, hook observations, reasoning attempts, validations, or explicit user rejection feedback, that can seed an **Evidence card** without external-system integration.
_Avoid_: third-party webhook, raw SaaS transcript, arbitrary import

**User rejection signal**:
An internal refinement signal where the user rejects, corrects, or constrains agent behavior; command/button feedback is high-confidence, while natural-language rejection is captured as lower-confidence evidence that cannot autopromote.
_Avoid_: casual preference, inferred mood, silent edit

**Evidence route**:
The destination verdict on an **Evidence card**: durable Memory fact, Skill improvement proposal, Red context update, issue/PRD candidate, or discard.
_Avoid_: automatic write target, ADR decision, unreviewed patch

**Evidence route verdict**:
The structured routing block on an **Evidence card**, combining route kind, target, decision, and reason.
_Avoid_: destination-only route, hidden router rationale, automatic write target

**Skill proposal target**:
The `skill_proposal` route target on an **Evidence card**, naming the Skill, its path, and the suggested section or anchor for review.
_Avoid_: skill name only, inferred patch target, hidden section choice

**Low-risk autopromotion**:
Automatic promotion of high-confidence, internal, low-blast-radius evidence such as validation outcomes or telemetry rollups into governed Memory, excluding Skill behavior changes and Red context updates.
_Avoid_: autorefine, silent patch, automatic context rewrite

**Refinement blast-radius gate**:
The review gate that blocks autopromotion when an evidence route could affect an external audience, customer/commercial/security outcomes, or shared workflow/context semantics.
_Avoid_: gut-check, trust score, generic risk

**Evidence blast-radius assessment**:
The **Evidence card** block that records the three blast-radius axes, a derived level, and the reason for that level.
_Avoid_: single opaque risk score, generic severity, unstated gate rationale

**Refinement judge**:
The review function that checks whether an **Evidence card** has enough evidence, confidence, privacy posture, blast-radius assessment, and routing quality before producing or applying a proposal.
_Avoid_: eval runner, automatic approver, model preference

**Evidence judge block**:
The **Evidence card** block that records judge checklist results plus verdict, confidence, and reason.
_Avoid_: score-only judge, hidden model judgment, eval result

**Refinement cadence**:
The operating rhythm for the **Hermes-like refinement loop**: capture evidence near session or hook events, then review routed cards and proposals through an explicit manual or scheduled batch.
_Avoid_: always-on rewrite, hidden background mutation, one-off cleanup

**Skill creation candidate**:
An evidence-backed recommendation that repeated work may deserve a new Skill, routed as issue/PRD work instead of being created automatically by the refinement loop.
_Avoid_: auto-created skill, throwaway procedure, Hermes-style skill spawn

**Markdown-only mode**:
The lightest Memory storage mode: plain markdown facts, no RedDB, hooks, or MCP server.
_Avoid_: lite mode, no-engine mode

**Graph mode**:
The RedDB-backed Memory storage mode using typed nodes and edges through `MemoryStore`.
_Avoid_: db mode, sql mode

**Memory operation**:
A single read-only Memory surface registered once as a `MemoryOperation<Input, Output>` — id, input/output schema, `execute`, and the declarative facets a transport needs to bind it (input binding, output kind, renderer metadata). The report+viewer pairs are Memory operations.
_Avoid_: command, endpoint, handler

**Memory operation registry**:
The transport-neutral seam over all read-only **Memory operations** (`createReadOnlyMemoryOperationRegistry`). It is the single place an operation is defined; CLI, MCP, and HTTP are **Transport adapters** that consume it rather than re-declaring dispatch. Mutating and infra surfaces (autocure, OpenAPI, health, workbench) stay outside the registry by design.
_Avoid_: dispatch table, router, operation map

**Transport adapter**:
A thin consumer of the **Memory operation registry** for one runner-facing transport: it binds input from its transport (argv/flags, MCP arguments, HTTP query) and routes output to its sink (stdout markdown/JSON, file artifact, HTTP response). MCP is already a pure Transport adapter; CLI and HTTP still hand-wire per operation.
_Avoid_: transport layer, gateway, controller

**Memory note**:
A single fact stored as one markdown file in **Markdown-only mode**.
_Avoid_: memory record, entry

**Memory node**:
The graph-mode unit for a stored fact, work item, attempt, file, symbol, validation, or other typed entity.
_Avoid_: note, row

**Pinned Memory node**:
A **Memory node** whose `importance >= 0.8`; it is protected from stale-node pruning and treated as core context by context-pack policy when it is applicable to the current goal, not globally injected into every prompt. Recall ranking may learn from the same signal later, but context-pack is the first validation surface.
_Avoid_: pinned field, separate always-include flag

**Memory tier**:
The retention class on a **Memory node**: `ephemeral`, `durable`, or `reasoning`.
_Avoid_: ttl class, expiry level, retention policy

**Memory layer**:
The physical storage layer a **Memory node** currently lives in: `L1` (in-process hot, per-agent turn), `L2` (RedDB session-scoped with TTL + size eviction), `L3` (RedDB graph, durable). Orthogonal to **Memory tier**: a node's tier names its retention class, its layer names where it physically lives right now and may change on promotion or eviction.
_Avoid_: cache tier, storage tier, band

**Reasoning memory**:
Durable graph records of agent reasoning evidence, outcomes, touched files, decisions, and validation.
_Avoid_: chain-of-thought dump, transcript memory

**Reasoning attempt**:
The graph-backed audit object for one concrete agent attempt against a task or issue.
_Avoid_: transcript, raw attempt log, envelope clone

**Validation node**:
A graph node for one observed check execution, such as test, typecheck, lint, build, or another validation command.
_Avoid_: stdout parse, test note

**Validation sidecar**:
The AFK-produced JSONL file of structured validation records consumed by Memory when recording a **Reasoning attempt**.
_Avoid_: log scrape, validation summary

**Reasoning attempt hooks**:
The optional `hooks` array property on a **Reasoning attempt** node, carrying one `{lifecycle, command, exit_code}` entry per user-declared AFK lifecycle hook that ran during the attempt. Populated best-effort from the terminal Envelope's hook section; absent (not empty) when no user hooks ran.
_Avoid_: envelope hook dump, hook log

**Memory event log**:
The RedDB-backed operational telemetry stream for Memory-visible agent events, including skill events, attempt validations, hook events, and derived lifecycle observations.
_Avoid_: separate telemetry tables, raw logs

**Memory injection observation**:
A Memory event-log observation that a recalled **Memory node** or **Memory context pack** citation was actually placed into agent context by a Memory-controlled hook or transport; event-log records are the source of truth, while node-level injection counters or timestamps are derived rollups for cheap doctor/decay queries. Manual recall display does not create an injection observation. Distinct from recall access bookkeeping such as `access_count`.
_Avoid_: recall hit, access count, prompt transcript, rollup source of truth

**Memory context pack generation observation**:
A Memory event-log observation that a **Memory context pack** was produced for a goal; distinct from a **Memory injection observation**, because generating ready-to-inject Markdown does not prove that an integration or hook delivered it to an agent.
_Avoid_: injection observation, recall access, prompt delivery

**Brain federated context**:
Cited Brain hits that Memory recall or context-pack may rank in the same result and trust model as Memory evidence, while preserving Brain as the canonical source for those artifacts rather than treating Brain as a Memory store.
_Avoid_: shared store, uncited Brain injection, separate supplemental section

**Memory readiness envelope**:
The shared JSON contract consumed by future UI and competitive evaluation, combining task readiness, trust evidence, operational telemetry, VCS/time-travel status, and graph-community signals for a requested goal.
_Avoid_: viewer payload, benchmark fixture

**Memory handoff report**:
The read-only cross-agent brief generated from recent graph evidence, with active work, decisions, validations, risks, relevant context, citations, and ready-to-inject markdown.
_Avoid_: raw transcript, session dump

**Memory work frontier**:
The read-only planning report that ranks remembered `task`, `issue`, `goal`, and `prd` nodes into ready, blocked, and completed work from RedDB graph evidence and dependency edges.
_Avoid_: mutating task manager, issue tracker replacement

**Work frontier viewer**:
The self-contained HTML artifact that renders **Memory work frontier** evidence for local planning inspection, including priorities, dependency blockers, citations, ready-to-inject markdown, and embedded JSON.
_Avoid_: kanban board, lock/lease service

**Handoff viewer**:
The self-contained HTML artifact that renders a **Memory handoff report** for local cross-agent continuation inspection, including ready-to-inject markdown and embedded JSON.
_Avoid_: transcript viewer, live collaboration room

**Memory vector projection**:
The RedDB-backed embedding mirror over Memory nodes, asset metadata nodes, and ingested document chunks, stored in `memory_vectors` for provider embeddings or `memory_kv` for deterministic local-dev embeddings, and used as a seed/status substrate for hybrid recall, asset-aware smart search, and documentation coverage.
_Avoid_: external vector DB, standalone embedding cache

**Memory local vector projection**:
The opt-in deterministic hashed embedding fallback for development, selected by `RED_MEMORY_VECTOR_PROVIDER=local` or `memory vector ... --local`, persisted in RedDB KV, and reused by later vector status/search reads when no provider is configured.
_Avoid_: hosted embedding parity, benchmark embedding model

**Memory vector search diagnostic**:
The read-only vector search/reporting surface over grounded vector candidates, including asset path/kind/media metadata when the hit is a **Memory asset inventory** node, used to inspect embedding behavior without bypassing governed recall.
_Avoid_: canonical recall answer, direct ungoverned document retrieval

**Vector status viewer**:
The self-contained HTML artifact that renders **Memory vector projection** readiness for local inspection, including ready/stale/unavailable/failed counts and node/doc vector target details.
_Avoid_: vector maintenance, canonical recall answer

**Memory smart search**:
The read-only composite search surface that returns fused top results plus governed recall hits, ingested document hits, asset inventory hits, and vector diagnostics in one contract.
_Avoid_: vector-first recall, ungoverned search ranking

**Smart search viewer**:
The self-contained HTML artifact that renders **Memory smart search** with fused results, recall/doc/asset/vector counts, source references, asset/vector detail, recommendations, and embedded JSON.
_Avoid_: generated answer page, replacement recall UI

**Memory doc coverage report**:
The read-only report that checks whether ingested `memory_docs` chunks have graph root nodes, extracted reference edges, and vector projection coverage.
_Avoid_: documentation linter, recall score

**Memory doc reference graph**:
The read-only graph report that materializes ingested documentation chunks, referenced Memory nodes, and extracted `REFERENCES` edges for inspection through CLI, MCP, HTTP, and the Workbench.
_Avoid_: separate docs graph store, filesystem crawler

**Memory asset inventory**:
The deterministic RedDB-backed inventory of binary document/media assets such as PDFs, images, audio, video, and office files, stored as `file` nodes with path, media type, size, hash, and provenance but without pretending to extract OCR/transcripts.
_Avoid_: OCR pipeline, multimodal embedding parity claim, binary body storage

**Asset inventory viewer**:
The self-contained HTML artifact that renders **Memory asset inventory** metadata for local inspection through CLI, MCP, and HTTP.
_Avoid_: asset previewer, binary file server, OCR dashboard

**Memory doc related report**:
The read-only per-document report that returns a target indexed doc's extracted references plus other indexed docs that share those references.
_Avoid_: recommender, semantic similarity score

**Memory doc backlinks report**:
The read-only inverse documentation report that returns indexed docs pointing at a referenced Memory node by rid, label, title, or query.
_Avoid_: global search result, semantic citation ranker

**Memory doc evidence pack**:
The read-only agent context contract that combines one indexed doc body, extracted references, related docs, warnings, and ready-to-inject markdown.
_Avoid_: LLM answer, docs summary rewrite

**Doc evidence pack viewer**:
The self-contained HTML artifact that renders a **Memory doc evidence pack** for local inspection, including indexed body markdown, references, related docs, warnings, and embedded JSON.
_Avoid_: docs editor, regenerated source page

**Doc search viewer**:
The self-contained HTML artifact that renders **Memory doc search** results for local inspection, with links into **Doc brief viewer**, **Doc bundle viewer**, and **Doc evidence pack viewer** surfaces.
_Avoid_: docs portal, filesystem search page

**Memory docs brief**:
The read-only query-level evidence contract that composes a **Memory docs bundle** into `[D#]` citations, extracted-reference context, gaps, next actions, and ready-to-inject markdown without calling an LLM.
_Avoid_: synthesized answer, citation hallucination

**Doc brief viewer**:
The self-contained HTML artifact that renders a **Memory docs brief** for local inspection, including citations, gaps, next actions, and embedded agent markdown.
_Avoid_: answer page, generated documentation summary

**Memory docs bundle**:
The read-only query-level context contract that searches indexed docs and composes top-hit **Memory doc evidence pack** outputs into one markdown bundle.
_Avoid_: synthesized answer, vector-only retrieval result

**Doc bundle viewer**:
The self-contained HTML artifact that renders a **Memory docs bundle** for local inspection, including search hits, evidence-pack status, warnings, and embedded agent markdown.
_Avoid_: generated docs site, LLM-written summary page

**Doc backlinks viewer**:
The self-contained HTML artifact that renders a **Memory doc backlinks report** for local inspection.
_Avoid_: citation browser, semantic search UI

**Doc related viewer**:
The self-contained HTML artifact that renders a **Memory doc related report** for local inspection.
_Avoid_: recommendation dashboard, semantic search UI

**Doc reference graph viewer**:
The self-contained HTML artifact that renders the **Memory doc reference graph** as a local docs-to-reference graph inspection surface.
_Avoid_: graph editor, separate visualization service

**Memory project bootstrap**:
The graph-mode seeding workflow that discovers README, docs, agent rules, Red context docs, ADRs, and optional git log evidence, then indexes them through the normal markdown ingest path.
_Avoid_: separate wiki import, one-off setup script

**Doc coverage viewer**:
The self-contained HTML artifact that renders the **Memory doc coverage report** for local inspection.
_Avoid_: docs site, external dashboard

**Memory hook coverage report**:
The read-only report that compares project hook config with Claude/Codex hook manifests, runner-specific lifecycle differences, effective fallback coverage, and actionable hook gaps.
_Avoid_: hook installer, automatic hook enablement

**Hook coverage viewer**:
The self-contained HTML artifact that renders **Memory hook coverage report** evidence for local inspection, including runner manifest paths, enabled/effective lifecycle events, gaps, recommendations, and embedded JSON.
_Avoid_: hook installer, live hook editor

**Memory session timeline**:
The read-only replay-style report over append-only hook lifecycle and Skill telemetry events, grouped by session and scrubbed of raw transcript text.
_Avoid_: raw chat replay, transcript archive

**Session timeline viewer**:
The self-contained HTML artifact that renders a **Memory session timeline** for local replay inspection.
_Avoid_: live server dashboard, transcript player

**Memory operational dashboard**:
The self-contained HTML artifact and JSON contract that aggregates Memory stats, doc coverage, vector readiness, hook coverage, extraction readiness, stale evidence, decay posture, warnings, and next actions.
_Avoid_: graph export, external observability dashboard

**Memory workbench**:
The self-contained HTML artifact that composes the operational dashboard, capability catalog, competitive radar, memory layers, and session timeline into one local operator UI.
_Avoid_: live web server, separate source of truth

**Workbench memory layers panel**:
The read-only browser panel inside the **Memory workbench** that renders **Memory layers report** evidence, refreshes it through `/api/layers`, and links to **Memory layers viewer** when served by **Memory local HTTP server**.
_Avoid_: separate architecture dashboard, mutating readiness repair

**Workbench search console**:
The read-only browser search panel inside the **Memory workbench** that calls `/api/search` when served by **Memory local HTTP server** and renders fused smart-search results, recall/doc/asset/vector counts, result sources, references, and recommended next actions.
_Avoid_: mutating browser UI, replacement recall engine

**Workbench context pack panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/context-pack` and links to **Memory context pack viewer** for goal-oriented, budgeted, cited agent context.
_Avoid_: prompt editor, hidden LLM summarizer

**Workbench docs explorer**:
The read-only browser panel inside the **Memory workbench** that calls `/api/docs/search`, `/api/docs/brief`, `/api/docs/bundle`, `/api/docs/read`, `/api/docs/evidence-pack`, `/api/docs/backlinks`, `/api/docs/related`, `/api/docs/coverage`, and `/api/docs/reference-graph`, and links to **Doc search viewer**, **Doc evidence pack viewer**, and **Doc related viewer** pages to search, brief, bundle, open, pack, trace references, relate, audit, and map indexed `memory_docs` chunks.
_Avoid_: filesystem browser, raw docs server

**Workbench handoff panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/handoff` and links to **Handoff viewer** for cross-agent continuation.
_Avoid_: transcript replay, chat exporter

**Workbench work frontier panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/frontier` and links to **Work frontier viewer** for ready/blocked work planning.
_Avoid_: task editor, lease coordinator

**Workbench graph path explorer**:
The read-only browser panel inside the **Memory workbench** that calls `/api/path-explain` to explain directed Memory graph paths between labels or titles.
_Avoid_: graph editor, visualization-only graph canvas

**Workbench onboarding map panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/onboarding-map` and links to **Onboarding map viewer** for map-first repository orientation.
_Avoid_: generated tutorial, filesystem crawler

**Workbench vector diagnostics**:
The read-only browser panel inside the **Memory workbench** that calls `/api/vector/status` and `/api/vector/search` to inspect projected vector readiness and candidate hits, and links to the **Vector status viewer** for the same readiness evidence.
_Avoid_: vector maintenance, canonical recall answer

**Workbench hook diagnostics**:
The read-only browser panel inside the **Memory workbench** that calls `/api/hooks/coverage` and `/api/session/timeline` to inspect hook wiring and recent lifecycle evidence.
_Avoid_: hook installer, transcript replay

**Workbench extraction status panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/extraction/status` to inspect deterministic extractor coverage, local structured-transcript fallback readiness, inferred provider configuration, Stop hook readiness, and stored inferred fact counts, and links to the **Extraction status viewer** for the same evidence.
_Avoid_: provider setup wizard, extraction writer

**Workbench learning debt panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/learning-debt` and links to **Learning debt viewer** for self-improvement debt inspection.
_Avoid_: mutating skill curator, automatic skill repair

**Workbench memory health panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/memory/health` and links to **Memory health viewer** for operational Memory readiness inspection.
_Avoid_: server liveness check, mutating repair wizard

**Workbench governance panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/governance` and links to **Memory governance viewer** for provenance, privacy, lint, contradiction, and supersession inspection.
_Avoid_: mutating compliance wizard, automatic redaction/export

**Workbench decay panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/decay` and links to **Decay viewer** for retention posture inspection.
_Avoid_: cleanup UI, destructive pruning workflow

**Workbench agent routing panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/routing-guide` and links to **Routing guide viewer** for agent-specific Memory adoption guidance.
_Avoid_: rule installer, agent account manager

**Workbench agent integration status panel**:
The read-only browser panel inside the **Memory workbench** that calls `/api/integration-status` and links to **Agent integration status viewer** for agent rule-file, routing-snippet, and hook-coverage status.
_Avoid_: rule installer, hook enabler, agent account manager

**Workbench competitive eval panel**:
The Workbench section that surfaces the embedded `evaluateCompetitiveEvalV2` result, including the "Eval score/max" metric and a link to `/competitive-eval`.
_Avoid_: workbench eval card, competitive panel

**Memory capability catalog**:
The read-only JSON/MCP contract that groups Memory's agent surfaces by retrieval, docs, vectors, UI, hooks, code graph, governance, telemetry, and interop capability.
_Avoid_: marketing checklist, static README matrix

**Memory competitive radar**:
The read-only planning report that maps **Memory capability catalog** evidence to named competitor axes and next actions without making public benchmark claims.
_Avoid_: win claim, marketing matrix

**Competitive eval viewer**:
The self-contained HTML artifact (contract `memory.competitive_eval.viewer.v1`) that renders `memory.competitive_eval.v2` with composite score, dimensions, live baselines, claim guards, and an embedded JSON data block.
_Avoid_: eval HTML, benchmark report

**Memory path explanation**:
The read-only graph report that resolves a directed path between two Memory labels into nodes, edge labels, citations, and markdown.
_Avoid_: raw graph row dump, visualization-only path

**Memory ask gap analysis**:
The structured evidence-gap report returned with `memory ask`, derived from active evidence, superseded evidence, contradictions, and confidence buckets.
_Avoid_: model opinion, uncited answer caveat

**Memory backup snapshot**:
The local `.red/memory/backups/<name>` copy of project Memory persistence, with a SHA-256 manifest and explicit restore gate.
_Avoid_: graph export, cloud backup, implicit restore

**Memory interop export**:
The optional read-only export bundle that derives JSONL node/edge streams, GraphML, and Neo4j Cypher from the project-local RedDB Memory graph.
_Avoid_: migration of source of truth, live Neo4j sync

**Memory doc restore**:
The explicit restore-only workflow that writes indexed `memory_docs` bodies from RedDB back to a safe output directory or, with `--in-place --yes`, to original in-repo paths.
_Avoid_: automatic file sync, unreviewed overwrite

**Memory local HTTP server**:
The optional loopback-only read-only server that exposes the Workbench, operational dashboard, **Agent integration status viewer**, **Communities viewer**, **Decay viewer**, **Doc backlinks viewer**, **Doc brief viewer**, **Doc bundle viewer**, **Doc evidence pack viewer**, **Doc reference graph viewer**, **Doc search viewer**, **Handoff viewer**, **Learning debt viewer**, **Memory context pack viewer**, **Memory governance viewer**, **Memory health viewer**, **Memory layers viewer**, **Onboarding map viewer**, **Routing guide viewer**, **Work frontier viewer**, competitive radar, context packs, work frontier, memory layers, memory governance, memory decay, memory health, memory routing guide, memory agent integration status, learning debt, extraction status, **Extraction status viewer**, hook coverage, session timeline, **Vector status viewer**, docs search/brief/bundle/read/evidence-pack/backlinks/related/coverage/reference-graph, OpenAPI, health, smart search, handoff, and recall JSON over HTTP.
_Avoid_: required daemon, remote Memory service

**Memory multi-agent integration guide**:
The read-only routing/adoption contract that emits target rule files, MCP stdio config, HTTP command, hook notes, and CLI fallbacks for Codex, Claude, Cursor, Gemini, Aider, OpenCode, and generic MCP/HTTP agents.
_Avoid_: cloud sync service, agent-specific memory backend

**Memory agent integration status**:
The read-only audit contract over supported agents' rule files, Memory routing snippets, MCP/HTTP guidance, and hook coverage.
_Avoid_: integration installer, agent-specific memory backend, hook mutator

**Agent integration status viewer**:
The self-contained HTML artifact that renders **Memory agent integration status** evidence for local multi-agent adoption inspection.
_Avoid_: hosted onboarding wizard, rule installer, hook editor

**Memory layers report**:
The read-only architecture report that maps short-term session events, long-term durable graph facts, reasoning traces, docs/code graph evidence, and vector projection into one RedDB-backed contract.
_Avoid_: separate storage engine, marketing-only architecture diagram

**Memory layers viewer**:
The self-contained HTML artifact that renders **Memory layers report** evidence for local layered-architecture inspection, including layer status, RedDB collections, competitor alignment, recommended next actions, and embedded JSON.
_Avoid_: separate architecture dashboard, persistence migration plan

**Learning debt viewer**:
The self-contained HTML artifact that renders **Memory learning debt** evidence for local self-improvement inspection, including repeated failure patterns, stale or contradicted guidance, missing validation evidence, Skill telemetry gaps, agent markdown, and embedded JSON.
_Avoid_: mutating skill curator, automatic skill repair

**Memory health**:
The read-only operational readiness report over graph stats, vector projection status, stale Memory nodes, Skill telemetry availability, and recommended next actions.
_Avoid_: HTTP server liveness, automatic repair status

**Memory health viewer**:
The self-contained HTML artifact that renders **Memory health** evidence for local operational inspection, including graph stats, vector readiness, stale-node diagnostics, Skill telemetry availability, recommended next actions, and embedded JSON.
_Avoid_: HTTP server health endpoint, mutating repair wizard

**Memory governance**:
The read-only trust report over graph provenance coverage, privacy scan findings, lint findings, contradiction state, supersession state, and recommended next actions.
_Avoid_: compliance certification, auto-fix workflow

**Memory tidy recommendation**:
A read-only duplicate or near-duplicate recommendation to merge Memory evidence through an approval-gated **Soft-merge edge**; the first provider-backed tidy scope does not decide supersession, deprecation, or contradiction resolution. Memory does not apply tidy recommendations automatically. Each provider tidy run is bounded by an absolute recommendation cap and a proportional guard against collapsing too much of the candidate set.
The first product surface for provider-backed tidy recommendations is **Memory governance**. When no provider is configured or provider tidy is unavailable, Memory governance remains deterministic and reports tidy as unavailable with the reason and next action.
A tidy recommendation's review status is `open`, `accepted`, `dismissed`, or `stale`; `accepted` means a human approved it through an explicit mutating workflow and Memory created the corresponding **Soft-merge edge**, while `stale` means the recommendation's **Provider review fingerprint** no longer matches current evidence or policy. `memory governance` only reports recommendations and never applies them. Graph supersession vocabulary is not used for provider review artifacts.
_Avoid_: automatic tidy, auto-merge, destructive cleanup, supersession decision, contradiction resolution, retention recommendation

**Memory lint rule suggestion**:
The read-only recommendation emitted by Memory lint when hygiene findings imply a reusable agent rule or Red context update, including target files, evidence IDs, rationale, and ready-to-paste markdown.
_Avoid_: automatic rule writer, Memory mutation

**Memory decay plan**:
The read-only retention report that classifies **Memory nodes** as keep, review, deprecate, or expire from access overlays, supersession, contradictions, TTL horizons, and pinned importance.
_Avoid_: automatic pruning, destructive cleanup

**Decay viewer**:
The self-contained HTML artifact that renders a **Memory decay plan** for local retention inspection.
_Avoid_: memory editor, delete confirmation screen

**Memory governance viewer**:
The self-contained HTML artifact that renders **Memory governance** evidence for local audit inspection, including embedded JSON.
_Avoid_: mutating governance dashboard, public benchmark claim

**Memory context pack viewer**:
The self-contained HTML artifact that renders **Memory context pack** evidence for local agent-context inspection, including embedded JSON, grouped citations, warnings, skill recommendations, and ready-to-inject Markdown.
_Avoid_: model-generated summary, separate prompt artifact store

**Memory context pack core context**:
The cited, provenance-preserving section of a **Memory context pack** for applicable **Pinned Memory nodes**; pinned nodes must still pass the same governed eligibility filters as ordinary context, then appear before ordinary recalled context without removing citations or trust metadata.
_Avoid_: uncited always-include preface, ranking-only boost, governance bypass

**Path explanation viewer**:
The self-contained HTML artifact that renders a **Memory path explanation** for local inspection.
_Avoid_: graph export, generic graph browser

**Deterministic entity grounding**:
The zero-token markdown extraction path that turns explicit doc references such as wiki-links, inline identifiers, and Markdown links into referenced Memory concept nodes plus `REFERENCES` edges.
_Avoid_: NER parity, inferred entity mining

**Incremental ingest manifest**:
The compact per-file RedDB KV state that lets `memory refresh` and PostToolUse hooks skip unchanged files and report stale graph elements, with chunked element hashes for docs with many references.
_Avoid_: full graph snapshot, deletion planner

**Deterministic call graph**:
The zero-token code extraction path that emits conservative `CALLS` edges between symbols when the relationship is visible in source text.
_Avoid_: whole-program static analysis, runtime trace

**Deterministic type-use graph**:
The zero-token code extraction path that emits conservative `USES_TYPE` edges between symbols when a local type/interface/class name is visible in a symbol body or signature.
_Avoid_: type checker, complete semantic graph

**Deterministic SQL schema graph**:
The zero-token SQL extraction path that emits file, table, column, and foreign-key `REFERENCES` evidence from `.sql` schema files into structural impact and pre-PR risk reads.
_Avoid_: database introspection, ORM migration runner

**Deterministic dev-workflow graph**:
The zero-token extraction path that records `package.json` scripts, Dockerfile stages/steps, GitHub Actions jobs/actions, and shell functions as RedDB workflow/import evidence.
_Avoid_: CI runner, container build parser

**Memory extraction status**:
The read-only operator report that shows deterministic extractor coverage, local structured-transcript fallback readiness, inferred provider mode/model/egress, Stop hook readiness, and stored `INFERRED` fact count.
_Avoid_: provider installer, extraction quality benchmark

**Provider review fingerprint**:
A stable hash over the relevant Memory nodes/edges plus the Memory operation id and provider-review policy/prompt version; used to skip repeated provider-backed review work only when both evidence and review policy are unchanged. Deterministic readers still recompute their reports rather than trusting the fingerprint.
_Avoid_: report cache, governance cache, deterministic skip

**Provider review artifact**:
A persisted, non-canonical review result keyed by **Provider review fingerprint**, such as stable **Memory tidy recommendation** ids and pair-level evidence for reviewers. It lives in Memory persistence outside the canonical graph, such as RedDB KV or a side collection. It is not a **Memory node** or edge and does not change governed recall until an approved action creates canonical graph evidence.
_Avoid_: Memory node, Soft-merge edge, recall evidence, markdown review file

**Extraction status viewer**:
The self-contained HTML artifact that renders **Memory extraction status** for local inspection, including deterministic extractor coverage, inferred provider readiness, Stop hook readiness, inferred fact counts, recommendations, and embedded JSON.
_Avoid_: provider setup wizard, extraction runner

**Memory routing guide**:
The read-only artifact that tells agents when to call Memory tools and which AGENTS.md or CLAUDE.md rule file should receive the snippet.
_Avoid_: auto-installed rules, prompt injection

**Routing guide viewer**:
The self-contained HTML artifact that renders **Memory routing guide** evidence for local multi-agent adoption inspection, including target files, transports, config snippets, routing rules, and embedded JSON.
_Avoid_: rule installer, hosted onboarding wizard

**Structural impact viewer**:
The self-contained HTML artifact that renders file/symbol impact evidence from Memory graph relationships such as imports, calls, type uses, references, and definitions.
_Avoid_: separate IDE, generated source map

**Pre-PR review viewer**:
The self-contained HTML artifact that renders changed files, impacted concepts, decisions, failures, validations, risks, and evidence markers from **Memory pre-PR review**.
_Avoid_: GitHub PR UI clone, unchecked checklist

**Memory graph communities**:
Derived RedDB graph community assignments for Memory nodes, exposed as read-only analytics with cacheable assignments and human-readable top labels per community.
_Avoid_: stored evidence, hand-authored clusters

**Communities viewer**:
The self-contained HTML artifact that renders **Memory graph communities** for local inspection, including community summaries, assigned nodes, graph hash, cache state, and embedded JSON.
_Avoid_: graph editor, durable cluster evidence

**Community digest**:
The derived per-community summary over **Memory graph communities** — a deterministic top-label baseline always, optionally upgraded to a provider-generated narrative — cached by graph hash and treated as analytics, never written back as a **Memory node** or edge.
_Avoid_: durable summary node, recall corpus entry

**Memory global search**:
The read-only sibling surface (alongside `memory architecture-overview`) that answers broad, zoom-out queries from **Community digest** evidence; opt-in and explicit, it never mutates or routes the canonical governed recall path.
_Avoid_: vector-first recall, automatic recall blending

**Extraction schema**:
The two-axis schema that governs provider-backed `memory extract`: a closed **Structural type** axis (strict-write validated) and an open, indexed **Engineering code** axis. It shares the structural vocabulary with the lossless-read graph contract, so export stays permissive while inference stays consistent — and an out-of-vocabulary classification lands as a free code on a valid structural node rather than being rejected.
_Avoid_: per-project custom ontology, single conflated type axis

**Structural type**:
The closed axis of a **Memory node**'s kind — the small set with distinct edge/query/storage behaviour (`file`, `symbol`, `concept`, `issue`, `prd`, `attempt`, `validation`, …) — validated by the **Extraction schema** strict-write profile. A fact whose proposed kind is not structural lands on a base structural type and carries its classification as an **Engineering code**.
_Avoid_: semantic flavour, fine-grained fact kind

**Engineering code**:
The open, indexed axis that carries a **Memory node**'s fine-grained semantic classification (the "why"/kind: decision, gotcha, risk, root-cause, …), modelled on TigerBeetle's `code`/`user_data`. Unknown codes are accepted and never rejected; recall, community digests, and clusters may use the code as a first-class dimension.
_Avoid_: free-text tag, recall-invisible metadata

**Code drift report**:
The read-only report that aggregates unknown **Engineering code** values by recurrence so a recurring code can be promoted into the suggested vocabulary (or aliased) while one-off noise is aliased or left; it replaces the former out-of-vocabulary quarantine.
_Avoid_: write gate, recall exclusion

**Soft-merge edge**:
The `SAME_AS`/`MERGED_INTO` edge that represents an approved post-hoc entity merge by hiding the duplicate **Memory node** from canonical recall without deleting it or its provenance; reversing the merge removes the edge.
_Avoid_: physical node collapse, destructive dedup

**RedDB Statistics**:
The RedDB analytical surface for aggregate counts, rankings, and rollups derived from project data.
_Avoid_: stats, metrics store

**Skill telemetry**:
Observed lifecycle and interaction events for a **Skill**, stored as runner-neutral Memory evidence.
_Avoid_: skill metrics, usage counters

**Curatable skill**:
A skill whose files may be modified, consolidated, or archived because it is user-owned or agent-created.
_Avoid_: stale skill, editable skill

**Skill curator report**:
The Memory-owned, report-only recommendation output over **Skill telemetry**.
_Avoid_: mutating curator, automatic cleanup

**Memory learning debt**:
The Memory-owned, read-only report over repeated failed attempts, stale or contradicted guidance, missing validation evidence, and Skill telemetry gaps.
_Avoid_: mutating skill repair, issue triage queue

**Engineering semantic graph**:
The Memory schema claim that engineering objects such as issues, PRDs, attempts, files, symbols, validations, skills, ADRs, and decisions are first-class graph nodes and relationships.
_Avoid_: better graph, Neo4j killer

**RedDB-native Memory moat**:
The Memory product strategy that makes RedDB's embedded multi-model engine the coordinating advantage across UI, MCP/API, benchmarks, ingest, governance, and self-improvement work.
_Avoid_: generic database backend, storage detail

**Memory moat foundation**:
The first-cycle implementation stance that completes the core RedDB-backed substrate for vector/hybrid recall, VCS/time-travel memory, operational telemetry, and graph analytics before treating UI, MCP/API, or benchmarks as the primary work.
_Avoid_: surface-first roadmap, demo-driven roadmap

**Memory product evidence base**:
The current RedSkills repository itself — ADRs, contexts, PRDs, code, tests, issues, and Memory graph evidence — used as the proof surface for Memory product direction instead of a separate demo corpus.
_Avoid_: demo project, synthetic showcase

**Codebase mapping parity**:
The goal of covering practical repository-understanding capabilities: ingestion, graph construction, impact queries, context maps, and exportable artifacts.
_Avoid_: Understand clone, Graphify clone

**Memory map**:
A RedDB-backed, rebuildable projection of codebase-map evidence used by Memory to sharpen agent context between Claude Code/Codex and the repository while reducing unnecessary token use. It is derived from canonical Memory graph evidence and complementary ingest sources without becoming a second source of truth. It includes structural codebase entities plus operational evidence such as ADRs, decisions, validations, issues, PRDs, and attempts only when they are explicitly connected to files, symbols, docs, or assets. red-ui can inspect the same data as a database visualization client, but the primary product loop is agent context selection.
_Avoid_: graphify-out clone, static map artifact, separate map database

**Memory map versioning**:
The rule that **Memory map** does not maintain its own snapshot/versioning system; it is recomputed from the queried RedDB graph state and relies on RedDB VCS/time-travel for historical reads.
_Avoid_: map snapshot store, parallel graph history, committed map version

**Memory map analytic cache**:
The rebuildable RedDB-backed cache for expensive **Memory map metadata** such as community assignments and cohesion, computed through RedDB analytics capabilities for database visualization clients. Cheap metrics such as edge weight or salience may be computed on read unless materialization is proven necessary.
_Avoid_: map snapshot, canonical evidence, UI cache

**Memory map boundary**:
The rule that **Memory map** and Brain remain disconnected surfaces. Brain artifacts do not participate as Memory map vertices, edges, citations, or federated context.
_Avoid_: Brain-enriched map, federated Brain map context, shared project graph

**Memory map metadata**:
The semantic and analytic attributes Memory provides as decision inputs for database graph visualization, such as entity type, relation kind, edge weight, edge salience, confidence, provenance, community assignment, cohesion, and source freshness. It does not encode UI/UX decisions such as color palettes, layout, label visibility, opacity, interaction behavior, or visual hierarchy; those belong to red-ui or another frontend consumer.
_Avoid_: Memory UI projection, graph layout contract, red-ui implementation detail

**Memory map context slice**:
A compact, cited answer-shaped subgraph selected from **Memory map** evidence for Claude Code/Codex before broad source-file reading, containing the relevant files, symbols, relations, source locations, connected decisions, validations, risks, and recommended next reads within a token budget.
_Avoid_: raw graph dump, visual map, generated prose answer

**Memory map edge weight**:
The topological strength of a Memory map edge, usually the count or aggregate strength of concrete relationships between two vertices or two communities.
_Avoid_: confidence score, UI opacity, importance score

**Memory map edge salience**:
A navigation-oriented ranking score derived from **Memory map edge weight** plus evidence quality, relation kind, recency, and centrality signals.
_Avoid_: raw edge weight, visual style, confidence field

**TypeScript map source**:
The first complementary source for **Memory map** structural code evidence, using TypeScript compiler API or `tsserver` data to derive symbols, imports, exports, and call/type relationships before writing them into RedDB-backed map evidence.
_Avoid_: Graphify dependency, separate TypeScript index, tsserver as source of truth

**Onboarding map viewer**:
The self-contained HTML artifact that renders **Memory onboarding map** evidence for local inspection, including concepts, workflows, decisions, risks, validations, suggested skills, warnings, markdown, and embedded JSON.
_Avoid_: documentation generator, replacement README

**Neo4j Agent Memory parity**:
The goal of covering agent-memory capability classes with RedSkills APIs, RedDB storage, and project-local graph semantics.
_Avoid_: Neo4j clone, API parity, Cypher parity

**Agentmemory live baseline**:
The first live competitor baseline for Memory competitive evaluation, using `rohitg00/agentmemory` as the direct operational-memory comparison before broader graph, onboarding, or hosted-platform competitors.
_Avoid_: secondary competitor, README-only comparison

**Neo4j Agent Memory live baseline**:
The opt-in `eval:competitive:v2` baseline for measuring `neo4j-labs/agent-memory` recall-latency behavior through a caller-provided JSON-emitting wrapper around the available Neo4j-backed service.
_Avoid_: fixture-only latency claim, implicit Neo4j service dependency

**Competitive multi-agent integration dimension**:
The `eval:competitive:v2` axis that proves supported coding agents can be routed to the same project-local RedDB Memory store through **Memory routing guide**, **Memory agent integration status**, MCP tools, CLI fallbacks, and hook-backed runners.
_Avoid_: README-only integration claim, hosted-agent account matrix

**Public codebase map**:
A committed JSON projection of public-safe repository graph data at a specific `HEAD`.
_Avoid_: memory export, knowledge graph

**VCS-versioned memory graph**:
The graph-mode store slice whose RedDB collections participate in RedDB's git-for-data versioning.
_Avoid_: versioned memory, time-travel memory

**AS OF recall**:
A Memory recall query evaluated against a historical RedDB VCS reference such as a commit, branch, or tag, answering what Memory knew at that point.
_Avoid_: memory rollback, historical search

## Relationships

- The **Memory plugin** hard-depends on `dev`, but `dev` only soft-uses Memory through a bridge.
- **Markdown-only mode** stores **Memory notes**; **Graph mode** stores **Memory nodes**.
- A **Reasoning attempt** may connect to issue, PRD, file, and **Validation node** evidence.
- A **Validation sidecar** feeds **Validation nodes** and `TESTED_BY` edges; `validation_summary` remains a quick aggregate property.
- **Reasoning attempt hooks** live as a property on the **Reasoning attempt** node; absent when the project declared no user hooks, never represented as an edge or separate node.
- The **Memory event log** is the shared telemetry substrate for skill, attempt, and hook observations before specialized rollups are produced.
- A **Hermes-like refinement loop** distills raw signals into **Evidence cards**, routes them into **Operational evidence** or proposal artifacts, and keeps mutation behind proposal review gates.
- An **Evidence card** conforms to the **Evidence card contract**; the first contract is experimental even though cards are versioned and parseable.
- The first **Evidence card contract** includes essential fields plus proposal traceability, judge, and review metadata; deeper audit fields wait until real sources prove they are needed.
- A Skill telemetry **Evidence card source** records runner, Skill identity, rollup reference, and recent event references rather than copying the raw telemetry stream into YAML.
- An **Evidence card** uses **Evidence citations** to cite **Memory event log** records, hook observations, rejection notes, validation nodes, or external-system summaries without making the raw source itself the durable Memory fact.
- An **Evidence card status** tracks the review lifecycle of a card separately from the lifecycle of any proposal file or promoted Memory node it creates.
- An **Evidence card fingerprint** refreshes pending cards in `captured`, `routed`, or `proposed` status, but a new card is created after the previous card is approved, rejected, promoted, or archived.
- **Two-stage refinement review** is required for mutating routes: the card review accepts the evidence interpretation, and the proposal review accepts the concrete change.
- In the first cycle, approving an **Evidence card** updates card review metadata only; it does not change proposal contents or alter the existing proposal apply gate.
- Rejecting an **Evidence card** linked to a proposal should mark the proposal with a rejected-card warning, but should not archive or move the proposal automatically.
- The **Evidence inbox** is the first filesystem home for YAML **Evidence cards**, preserving the existing inbox while separating the new review contract.
- The **Evidence review CLI** first supports list, show, approve, and reject over the **Evidence inbox**; viewers and PR workflows may consume the same evidence contract later.
- `memory improve skills` remains the **Skill improvement proposal** surface, but its telemetry candidates should fit the **Evidence card** layer before patch proposals are applied.
- A **Skill telemetry evidence card** is the first tracer-bullet input for the **Hermes-like refinement loop**, proving telemetry → card → proposal before external sources are added.
- **Evidence tracer-bullet proof** is required before treating the **Evidence card contract** as usable beyond the first Skill telemetry slice.
- For Skill telemetry, `memory improve skills --write-proposal` may write an **Evidence-linked proposal** in the same run as the card; applying the proposal remains separately gated.
- Existing cardless proposal artifacts remain valid during transition, but new refinement proposal generators should emit **Evidence-linked proposals**.
- The JSON output for `memory improve skills --write-proposal` preserves existing proposal fields and adds an `evidenceCards` artifact list for compatibility.
- An **Evidence proposal link** must be bidirectional so card review and proposal review remain auditable from either queue.
- **Evidence card redaction** happens before persistence; privacy findings may stay on the card, but raw sensitive text must not.
- A `context_update` **Evidence route** produces a **Context update proposal** under the proposal queue rather than editing `.red/contexts/*/CONTEXT.md` directly.
- The first **Hermes-like refinement loop** is seeded by **Internal refinement signals**; external customer, SaaS, or webhook sources are later inputs that must pass the same evidence and privacy gates.
- A **User rejection signal** can seed an **Evidence card**, but only explicit command or UI feedback should be treated as high-confidence rejection evidence.
- An **Evidence route** determines what review artifact is proposed from an **Evidence card**; ADR candidates are outside the first routing set and remain governed by architecture-decision criteria.
- An **Evidence route verdict** records route kind, target, decision, and reason so reviewers can inspect router rationale.
- A `skill_proposal` **Evidence route** uses a **Skill proposal target** so the reviewer sees the Skill, file path, and suggested section before reading the patch.
- **Low-risk autopromotion** may store internal operational evidence, but **Skill improvement proposal** and Red context updates remain approval-gated.
- The **Refinement blast-radius gate** decides whether an **Evidence route** is eligible for **Low-risk autopromotion** or must become a human-reviewed proposal.
- An **Evidence blast-radius assessment** uses the external-audience, customer/commercial/security, and shared-workflow/context axes plus a derived level and reason.
- The **Refinement judge** evaluates evidence quality and safety for an **Evidence card**; it may recommend eval or validation, but it is not itself an eval harness.
- An **Evidence judge block** combines checklist fields with verdict, confidence, and reason; score-only judge output is not enough.
- The **Refinement cadence** separates near-event capture from batched human review, so evidence is not lost but mutations remain inspectable.
- A `skill_proposal` **Evidence route** patches existing Skills; a **Skill creation candidate** is routed as issue/PRD work for explicit human prioritization.
- The **Memory readiness envelope** is the contract shared by UI and `eval:competitive:v2`, so product views and benchmarks are backed by the same evidence.
- A **Memory handoff report** composes live graph evidence for cross-agent continuation; it does not read or expose raw transcripts.
- The **Handoff viewer** consumes a **Memory handoff report** instead of recomputing cross-agent continuation evidence.
- **Memory graph communities** are analytics over the graph, not durable evidence written back into graph nodes or edges.
- The **Communities viewer** consumes **Memory graph communities** evidence for local HTML inspection without writing derived clusters into the Memory graph.
- A **Community digest** is derived from **Memory graph communities** and inherits their analytics-only stance: it is cached by graph hash and regenerated when the graph moves, never written back as durable evidence.
- **Memory global search** consumes **Community digest** evidence as a sibling of `memory architecture-overview`; it never enters the canonical governed recall ranking, preserving "recall is canonical, vectors are optional contributors".
- The **Extraction schema** strict-write profile validates only the **Structural type** of provider-backed `INFERRED` facts; the deterministic zero-token extractors are typed by construction and share the structural vocabulary as a CI lint rather than a runtime gate.
- An out-of-vocabulary classification is never rejected: it lands as an **Engineering code** on a base **Structural type**, and the **Code drift report** surfaces recurring codes for promotion or aliasing — there is no quarantine state.
- The **Engineering code** axis is first-class: recall may filter/rank by code (alongside tier and type), and **Community digest** / **Memory graph communities** may group and label by it.
- A **Soft-merge edge** reuses the supersession mechanic (hide-not-delete) that already keeps superseded guidance out of recall, and is produced only by an approval-gated, reversible post-hoc merge pass — never by silent auto-merge.
- **Memory vector projection** covers **Memory nodes**, asset metadata nodes, and `memory_docs` chunks; governed recall accepts direct node hits and document hits that can be grounded by hash to applicable **Memory nodes**.
- **Memory local vector projection** is a development fallback (`RED_MEMORY_VECTOR_PROVIDER=local` or `--local`), not a public semantic embedding benchmark.
- **Memory vector search diagnostic** reports grounded vector candidates, preserving asset metadata for binary/media hits; **Memory recall** remains the canonical governed context surface.
- **Memory smart search** composes recall, docs, asset inventory, and vector diagnostics without replacing governed recall ranking.
- The **Smart search viewer** consumes the same contract for CLI, MCP, and HTTP inspection instead of recomputing or summarizing search evidence.
- **Memory project bootstrap** feeds **Memory doc coverage report** and **Memory operational dashboard** through the same markdown ingest path as ordinary `memory ingest`.
- A **Memory doc coverage report** proves whether documentation ingestion has graph grounding, deterministic reference extraction, and vector projection coverage.
- A **Memory doc reference graph** exposes the same documentation `REFERENCES` evidence as nodes and edges without creating another graph source of truth.
- A **Memory asset inventory** gives Graphify-style heterogeneous corpus awareness through RedDB metadata nodes before OCR/transcript/multimodal extraction exists.
- The **Asset inventory viewer** consumes **Memory asset inventory** instead of reading binary bodies or previewing files.
- A **Memory doc evidence pack** composes `memory_docs` body text and **Memory doc related report** evidence for agent context without calling an LLM.
- A **Memory docs brief** composes a **Memory docs bundle** into citation and gap evidence instead of asking a model to write an answer.
- A **Memory docs bundle** composes **Memory doc evidence pack** outputs from search hits instead of asking a model to synthesize docs context.
- A **Memory doc related report** derives per-document neighbors from the **Memory doc reference graph** instead of using a separate similarity index.
- A **Memory doc backlinks report** derives referenced-node-to-doc backlinks from the **Memory doc reference graph** without scanning the filesystem.
- The **Doc backlinks viewer** consumes the **Memory doc backlinks report** instead of recalculating reference topology.
- The **Doc brief viewer** consumes a **Memory docs brief** instead of recalculating citations or gap evidence.
- The **Doc bundle viewer** consumes a **Memory docs bundle** instead of recalculating search or evidence-pack content.
- The **Doc evidence pack viewer** consumes a **Memory doc evidence pack** instead of rereading docs or recomputing related-doc evidence.
- The **Doc search viewer** consumes **Memory doc search** results and links to existing doc viewers instead of becoming another docs index.
- The **Doc related viewer** consumes the **Memory doc related report** instead of recalculating related-document topology.
- The **Doc reference graph viewer** consumes the **Memory doc reference graph** instead of recalculating documentation topology.
- The **Doc coverage viewer** consumes the **Memory doc coverage report** instead of recalculating documentation coverage.
- A **Memory hook coverage report** audits lifecycle hook wiring and config; it never enables hooks.
- The **Hook coverage viewer** consumes **Memory hook coverage report** evidence for CLI, MCP, and HTTP inspection without enabling or editing hooks.
- A **Memory session timeline** turns operational events into replay evidence without exposing raw transcripts.
- The **Session timeline viewer** consumes **Memory session timeline** evidence instead of recalculating event history.
- The **Memory operational dashboard** composes existing read-only reports, including **Memory decay plan** evidence; it is an operator surface, not a replacement for graph export, recall, or cleanup workflows.
- The **Memory workbench** consumes dashboard, capability catalog, competitive radar, context pack, work frontier, governance, decay, extraction status, handoff, memory layers, and session timeline contracts instead of recomputing their source evidence.
- The **Memory layers viewer** consumes **Memory layers report** evidence instead of recalculating layered-memory readiness.
- The **Workbench memory layers panel** reads **Memory layers report** evidence over HTTP and links to **Memory layers viewer**; it never mutates layer readiness.
- The **Workbench search console** uses **Memory smart search** over HTTP and links to **Smart search viewer**; it never writes Memory or bypasses governed recall.
- The **Workbench context pack panel** exposes **Memory context pack** evidence over HTTP and links to **Memory context pack viewer**; it never writes Memory or asks a model to summarize context.
- The **Workbench docs explorer** reads only indexed `memory_docs` chunks, **Memory docs brief**, **Memory doc related report** evidence, coverage evidence, and the **Memory doc reference graph** over HTTP; it does not expose arbitrary repository files.
- The **Workbench docs explorer** links to **Asset inventory viewer** for binary/media metadata without serving raw assets.
- The **Workbench handoff panel** exposes **Memory handoff report** evidence over HTTP and links to **Handoff viewer**; it never reads raw transcripts or stores continuation notes.
- The **Workbench work frontier panel** exposes **Memory work frontier** evidence over HTTP and links to **Work frontier viewer**; it never edits task status, creates leases, or replaces the issue tracker.
- The **Workbench agent routing panel** exposes **Memory routing guide** evidence over HTTP and links to **Routing guide viewer**; it never edits agent rule files or installs integrations.
- The **Workbench agent integration status panel** exposes **Memory agent integration status** evidence over HTTP and links to **Agent integration status viewer**; it never edits agent rule files, enables hooks, or installs integrations.
- **Memory doc restore** rehydrates indexed documentation from RedDB only after explicit CLI intent; it is not a background sync daemon.
- The **Workbench graph path explorer** exposes **Memory path explanation** over HTTP; it never writes graph nodes or edges.
- The **Workbench onboarding map panel** exposes **Memory onboarding map** over HTTP and links to **Onboarding map viewer**; it never writes graph evidence.
- The **Workbench graph communities panel** exposes **Memory graph communities** over HTTP and links to **Communities viewer**; it never writes derived clusters into Memory graph evidence.
- The **Workbench vector diagnostics** inspects existing vector projection over HTTP and links to **Vector status viewer**; vector maintenance stays explicit in CLI/MCP workflows.
- The **Workbench governance panel** exposes **Memory governance** over HTTP and links to **Memory governance viewer**; it never redacts, resolves, supersedes, or exports evidence.
- The **Workbench decay panel** exposes **Memory decay plan** over HTTP and links to **Decay viewer**; it never prunes, deletes, supersedes, or rewrites evidence.
- The **Workbench memory health panel** exposes **Memory health** over HTTP and links to **Memory health viewer**; it never runs repair or claims server liveness.
- The **Workbench extraction status panel** inspects **Memory extraction status** over HTTP; it never runs extraction or configures a provider.
- The **Workbench learning debt panel** exposes **Memory learning debt** over HTTP and links to **Learning debt viewer**; it never patches, archives, or repairs skills.
- The **Workbench hook diagnostics** reads hook coverage and session timeline evidence over HTTP and links to **Hook coverage viewer**; it never enables hooks or exposes raw transcripts.
- The **Memory capability catalog** composes operator-facing capability evidence; it is read-only and points agents to existing CLI/MCP surfaces instead of replacing those surfaces.
- The **Memory competitive radar** consumes the **Memory capability catalog**; public comparison claims still require executable eval evidence.
- **Memory path explanation** turns graph reachability into agent-usable evidence; it complements raw `path`/`traverse` reads.
- **Memory ask gap analysis** makes GBrain-style answer gaps explicit while staying grounded in Memory evidence, supersession, contradictions, and confidence.
- A **Memory backup snapshot** preserves the local RedDB/notes/config persistence surface for restore; graph export remains the read-only inspection bundle.
- **Memory interop export** emits Graphify/Neo4j-style exchange artifacts while preserving RedDB as the canonical persistence layer.
- The **Memory local HTTP server** is optional UI/API transport over existing read-only Memory contracts, not the canonical persistence process.
- The **Memory local HTTP server** exposes docs search/brief/bundle/read/related/coverage/reference-graph and the **Doc brief viewer**, **Doc bundle viewer**, **Doc evidence pack viewer**, **Doc search viewer**, plus **Doc reference graph viewer** from `memory_docs` and graph evidence; it does not read arbitrary filesystem paths.
- The **Memory multi-agent integration guide** routes multiple coding agents to the same project-local RedDB Memory store through MCP, loopback HTTP, agent rules, and hooks where a runner supports them.
- The **Routing guide viewer** consumes **Memory routing guide** evidence instead of installing agent rules or creating agent-specific stores.
- **Memory agent integration status** consumes **Memory routing guide** and **Memory hook coverage report** evidence; it does not install integrations or create agent-specific stores.
- The **Agent integration status viewer** consumes **Memory agent integration status** evidence instead of probing or editing agent runtime configuration itself.
- The **Memory layers report** proves the layered-memory architecture over existing RedDB collections; it does not create another persistence layer.
- The **Path explanation viewer** consumes **Memory path explanation** instead of recalculating graph reachability.
- **Deterministic entity grounding** improves documentation graph coverage but does not claim ML NER parity with spaCy/GLiNER/GLiREL pipelines.
- The **Incremental ingest manifest** is operational state for freshness; it does not store the source document graph or delete stale evidence automatically.
- The **Deterministic call graph** improves code impact queries but does not claim complete interprocedural analysis.
- The **Deterministic type-use graph** improves type-impact queries but does not replace a language type checker.
- The **Deterministic SQL schema graph** extends codebase mapping into database schema evidence without connecting to a live database.
- The **Deterministic dev-workflow graph** extends Graphify-style heterogeneous ingestion into package scripts, containers, CI workflows, and shell automation without executing them.
- **Memory asset inventory** extends Graphify-style heterogeneous corpus mapping to binary asset metadata while keeping source extraction explicit and honest.
- The **Vector status viewer** consumes **Memory vector projection** status for local HTML inspection without maintaining embeddings or bypassing governed recall.
- **Memory extraction status** makes inferred-extraction readiness inspectable, and the **Extraction status viewer** consumes the same contract for local HTML inspection; neither calls nor configures a provider.
- The **Learning debt viewer** consumes **Memory learning debt** evidence instead of recomputing failure, validation, guidance, or Skill telemetry gaps.
- The **Memory health viewer** consumes **Memory health** evidence instead of recomputing graph, vector, stale-node, or Skill telemetry readiness.
- The **Memory context pack viewer** consumes **Memory context pack** evidence instead of recalculating grouped recall, warnings, or skill recommendations.
- The **Memory work frontier** derives ready/blocked planning evidence from graph nodes and dependency edges; it does not create, assign, lease, or mutate work.
- **Memory governance** composes privacy, lint, provenance, contradiction, and supersession readers into one trust contract; the **Memory governance viewer** consumes that contract without performing fixes.
- A **Memory lint rule suggestion** is advisory only: agents may paste or adapt it into agent rules or Red context after review, but Memory never applies it automatically.
- A **Memory decay plan** is advisory only: it may recommend review, deprecation, or expiry handling, but it never prunes, deletes, supersedes, or rewrites Memory evidence.
- The **Decay viewer** consumes **Memory decay plan** evidence instead of recalculating retention policy or adding a mutating cleanup UI.
- **Memory pre-PR review** treats call/type-use dependents of changed symbols as explicit risk evidence.
- The **Memory routing guide** is an agent adoption surface; it does not mutate project rules unless a caller explicitly applies the snippet.
- The **Structural impact viewer** consumes structural impact evidence instead of reimplementing graph traversal logic.
- The **Pre-PR review viewer** consumes **Memory pre-PR review** evidence instead of recomputing changed-file risk logic.
- **Skill telemetry** feeds **Skill curator reports**; mutating archive decisions happen in the Dev context.
- **Memory learning debt** is report-only evidence for self-improvement; mutating skill changes remain outside Memory.
- **Engineering semantic graph** is the schema strategy behind **Codebase mapping parity** and **Neo4j Agent Memory parity**.
- The **RedDB-native Memory moat** coordinates product tracks by requiring visible RedDB-backed advantages, not just surface-area parity.
- The **Memory moat foundation** is the first-cycle priority before surface expansion, so UI, MCP/API, and benchmark work prove real RedDB substrate capabilities instead of placeholders.
- The **Memory product evidence base** is the shared proving ground for UI, benchmarks, MCP/API examples, public documentation, and roadmap decisions.
- The **Agentmemory live baseline** is the first external comparison for `eval:competitive:v2` because it competes directly in operational memory for coding agents.
- The **Neo4j Agent Memory live baseline** keeps Neo4j-backed recall-latency comparisons opt-in and measured instead of asserted from checked fixtures.
- The **Competitive multi-agent integration dimension** turns routing guide and integration status evidence into an executable claim guard for multi-agent support.
- A **VCS-versioned memory graph** is the source substrate for a **Public codebase map**.
- **AS OF recall** is the first user-facing capability of the **VCS-versioned memory graph**.

## Example dialogue

> **Dev:** "AFK posted an **Envelope** for the attempt. Should Memory store the full output?"
> **Domain expert:** "No. Store a **Reasoning attempt** with structured fields and connect it to **Validation nodes** from the **Validation sidecar**."

## Flagged ambiguities

- "memory" previously referred to both the plugin and generic agent recall; resolved: use **Memory plugin** for the product and **Reasoning memory** or **Memory node** for graph concepts.
- "validation summary" previously risked becoming parsed stdout; resolved: **Validation sidecar** is structured JSONL evidence, while `validation_summary` is only an aggregate property.
