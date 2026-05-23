# core — memory essentials

The minimal memory surface: set it up, write a fact, read it back.

| Skill | What it does |
|-------|--------------|
| **[init](./init/SKILL.md)** | One-time setup wizard. Markdown-only mode writes the per-project config (hooks off, MCP off, no RedDB) and creates the notes directory. |
| **[store](./store/SKILL.md)** | Save a fact as a plain markdown note under `.red/memory/notes/`. |
| **[recall](./recall/SKILL.md)** | Full-text search over the stored notes, ranked by relevance. |
| **[ingest](./ingest/SKILL.md)** | Walk a repo and populate the graph from code symbols + markdown structure (graph mode). |
| **[extract](./extract/SKILL.md)** | Extract durable `INFERRED` facts from a transcript into the graph through the configured AI provider. |
| **[skills-status](./skills-status/SKILL.md)** | Diagnose Skill telemetry and recent Skill usage events before self-improvement/curation. |
| **[improve-skills](./improve-skills/SKILL.md)** | Generate approval-gated Skill improvement proposals from Skill telemetry, then explicitly apply reviewed structured patches with `memory improve apply ... --yes`. |
| **[context-status](./context-status/SKILL.md)** | Report context stack readiness: agent rules, domain docs, ADRs, Memory mode/graph/freshness/telemetry, Wiki state, score, and recommendations. |
| **[doctor](./doctor/SKILL.md)** | List stale nodes (long-unaccessed, never recalled) and prune them after confirmation (graph mode). |
| **[export](./export/SKILL.md)** | Export the graph to a navigable graph.html + graph.json + audit.md (graph mode). |
