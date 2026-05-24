# RedSkills Memory

The `memory` context names persistent project memory, graph-backed reasoning
evidence, skill telemetry evidence, and the RedDB substrate used by engineering
workflows.

## Language

**Memory plugin**:
The RedSkills plugin that gives agents persistent, queryable per-project memory.
_Avoid_: memory skill, harness memory

**Markdown-only mode**:
The lightest Memory storage mode: plain markdown facts, no RedDB, hooks, or MCP server.
_Avoid_: lite mode, no-engine mode

**Graph mode**:
The RedDB-backed Memory storage mode using typed nodes and edges through `MemoryStore`.
_Avoid_: db mode, sql mode

**Memory note**:
A single fact stored as one markdown file in **Markdown-only mode**.
_Avoid_: memory record, entry

**Memory node**:
The graph-mode unit for a stored fact, work item, attempt, file, symbol, validation, or other typed entity.
_Avoid_: note, row

**Memory tier**:
The retention class on a **Memory node**: `ephemeral`, `durable`, or `reasoning`.
_Avoid_: ttl class, expiry level, retention policy

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

**Memory event log**:
The RedDB-backed operational telemetry stream for Memory-visible agent events, including skill events, attempt validations, hook events, and derived lifecycle observations.
_Avoid_: separate telemetry tables, raw logs

**Memory readiness envelope**:
The shared JSON contract consumed by future UI and competitive evaluation, combining task readiness, trust evidence, operational telemetry, VCS/time-travel status, and graph-community signals for a requested goal.
_Avoid_: viewer payload, benchmark fixture

**Memory graph communities**:
Derived RedDB graph community assignments for Memory nodes, exposed as read-only analytics with cacheable assignments and human-readable top labels per community.
_Avoid_: stored evidence, hand-authored clusters

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

**Neo4j Agent Memory parity**:
The goal of covering agent-memory capability classes with RedSkills APIs, RedDB storage, and project-local graph semantics.
_Avoid_: Neo4j clone, API parity, Cypher parity

**Agentmemory live baseline**:
The first live competitor baseline for Memory competitive evaluation, using `rohitg00/agentmemory` as the direct operational-memory comparison before broader graph, onboarding, or hosted-platform competitors.
_Avoid_: secondary competitor, README-only comparison

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
- The **Memory event log** is the shared telemetry substrate for skill, attempt, and hook observations before specialized rollups are produced.
- The **Memory readiness envelope** is the contract shared by UI and `eval:competitive:v2`, so product views and benchmarks are backed by the same evidence.
- **Memory graph communities** are analytics over the graph, not durable evidence written back into graph nodes or edges.
- **Skill telemetry** feeds **Skill curator reports**; mutating archive decisions happen in the Dev context.
- **Engineering semantic graph** is the schema strategy behind **Codebase mapping parity** and **Neo4j Agent Memory parity**.
- The **RedDB-native Memory moat** coordinates product tracks by requiring visible RedDB-backed advantages, not just surface-area parity.
- The **Memory moat foundation** is the first-cycle priority before surface expansion, so UI, MCP/API, and benchmark work prove real RedDB substrate capabilities instead of placeholders.
- The **Memory product evidence base** is the shared proving ground for UI, benchmarks, MCP/API examples, public documentation, and roadmap decisions.
- The **Agentmemory live baseline** is the first external comparison for `eval:competitive:v2` because it competes directly in operational memory for coding agents.
- A **VCS-versioned memory graph** is the source substrate for a **Public codebase map**.
- **AS OF recall** is the first user-facing capability of the **VCS-versioned memory graph**.

## Example dialogue

> **Dev:** "AFK posted an **Envelope** for the attempt. Should Memory store the full output?"
> **Domain expert:** "No. Store a **Reasoning attempt** with structured fields and connect it to **Validation nodes** from the **Validation sidecar**."

## Flagged ambiguities

- "memory" previously referred to both the plugin and generic agent recall; resolved: use **Memory plugin** for the product and **Reasoning memory** or **Memory node** for graph concepts.
- "validation summary" previously risked becoming parsed stdout; resolved: **Validation sidecar** is structured JSONL evidence, while `validation_summary` is only an aggregate property.
