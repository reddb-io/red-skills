# core — memory essentials

The minimal Memory surface is the governed loop: initialize a project-local
store, capture one durable work fact, recall it as evidence, verify risky claims,
and hand off cited context to the next agent/session.

Two modes exist:

- **markdown-only** — plain `.red/memory/notes/` files, no RedDB engine, hooks,
  MCP, or provider requirement. Good for cautious adoption.
- **graph** — governed operational memory in `.red/memory/graph.rdb`, with
  provenance, freshness, supersession, readiness, claim checks, context packs,
  optional hooks, and read-only MCP/HTTP/Workbench surfaces.

| Skill | What it does |
|-------|--------------|
| **[init](./init/SKILL.md)** | One-time setup wizard for markdown-only notes or graph-backed governed operational memory. |
| **[store](./store/SKILL.md)** | Save one scoped decision, gotcha, validation, risk, or why-note to the configured memory surface. |
| **[recall](./recall/SKILL.md)** | Return governed context from notes/graph evidence; graph mode ranks by usefulness and hides superseded guidance by default. |
| **[ingest](./ingest/SKILL.md)** | Walk a repo and populate the graph from code symbols + markdown structure (graph mode). |
| **[extract](./extract/SKILL.md)** | Extract durable `INFERRED` facts from a transcript into the graph through the configured AI provider. |
| **[skills-status](./skills-status/SKILL.md)** | Diagnose Skill telemetry and recent Skill usage events before self-improvement/curation. |
| **[improve-skills](./improve-skills/SKILL.md)** | Generate approval-gated Skill improvement proposals from Skill telemetry, then explicitly apply reviewed structured patches with `memory improve apply ... --yes`. |
| **[health](./health/SKILL.md)** | Report operational Memory health: graph readiness, freshness, telemetry rollups, ranked candidates, pending proposals, and next actions. |
| **[context-status](./context-status/SKILL.md)** | Report context stack readiness: agent rules, domain docs, ADRs, Memory mode/graph/freshness/telemetry, Wiki state, score, and recommendations. |
| **[doctor](./doctor/SKILL.md)** | List stale nodes (long-unaccessed, never recalled) and prune them after confirmation (graph mode). |
| **[export](./export/SKILL.md)** | Export the graph to a navigable graph.html + graph.json + audit.md (graph mode). |
