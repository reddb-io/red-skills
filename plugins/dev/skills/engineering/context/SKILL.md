---
name: context
working-mode: interactive
description: Build and refresh the project context stack before non-trivial work — domain glossary, ADRs, LLM Wiki, Memory graph, graph-aware zoom-out, and self-improvement signals. Use when the user asks to "get context", "manage context", onboard to a repo, prepare a large change, or improve agent memory/self-improvement loops.
---

# context

**Ground the session before non-trivial work — read committed docs, recall memory, zoom out, then drill in.**

<what-to-do>

## Context stack loop

Run these phases in order. Skip a phase only when its prerequisite is absent and the fallback says to skip.

### 1. Orient from committed project context

Read these first, if present:

1. `CLAUDE.md` or `AGENTS.md` — agent rules and registered skills.
2. `.red/CONTEXT.md` — canonical domain glossary.
3. `.red/adr/` — architectural decisions, newest relevant ADRs first.
4. `.red/CONTEXT-MAP.md` — monorepo context routing, if present.

Do not ask the user to repeat information that is already present in those files. If the glossary is missing a term you must use in the answer or plan, add or propose the term through the owning workflow (`/start` for domain/ADR updates) instead of inventing private vocabulary in chat.

### 2. Recall prior memory before re-deriving

If memory is configured here (a `plugins.memory` block in `.red/config.yaml`, or the legacy `.red/memory/config.json`), run a targeted recall before deep investigation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/../memory/scripts/bootstrap.mjs" recall "<topic terms>"
```

Use the configured Memory mode automatically. In graph mode, recall is neighborhood-expanded and supersede-aware; in markdown-only mode, it searches notes. Treat hits as historical claims: cite them internally, then verify against the current worktree before relying on them.

Fallback: if Memory is absent, unbuilt, uninitialized, markdown-only when graph is needed, or failing, continue with ordinary repo reads. Memory is an optimization, not a hard dependency of `dev`.

### 3. Refresh structural graph only when explicitly useful

Use graph indexing for large or unfamiliar codebases, impact analysis, onboarding, or repeated work across sessions:

```bash
node "${CLAUDE_PLUGIN_ROOT}/../memory/scripts/bootstrap.mjs" ingest . --root .
```

Only run this when Memory is initialized in graph mode. Do not run it from read-only skills such as `/zoom-out`; for those, recommend the command instead. Re-run after large refactors or before a long `/afk` wave if the graph is stale.

### 4. Zoom out before drilling in

Use `/zoom-out` semantics for map-first understanding:

- Start with modules/layers and ownership boundaries.
- Then explain relationships, critical paths, risks/gaps, and optional impact.
- Use Memory graph neighbors/paths only as evidence to interpret, never as raw dumps.
- Verify graph evidence against files before making claims.

For a concrete bug or feature, produce a short orientation map before reading leaf files. This mirrors the Understand-Anything / graphify lesson: the graph is valuable when it teaches how pieces fit together, not when it merely shows complexity.

### 5. Use the LLM Wiki for durable project knowledge

If `.red/agents/wiki.md` and `.red/wiki/` exist, use `/wiki query <question>` for compiled knowledge and `/wiki ingest <source>` for durable external or internal sources.

Rules:

- Read `.red/agents/wiki.md` before any wiki operation.
- Keep `.red/wiki/` gitignored; do not commit raw/private wiki state.
- File back only durable syntheses that would be painful to re-derive.
- Keep source pages, concept/entity pages, contradictions, and index/log current.

Fallback: if the wiki is not initialized and the project would benefit from compounding research/docs memory, recommend `/wiki-init` with the target domain.

### 6. Capture only durable learning

After a non-trivial investigation, store one fact per durable lesson:

```bash
node "${CLAUDE_PLUGIN_ROOT}/../memory/scripts/bootstrap.mjs" store "<decision, gotcha, or why-note>"
```

Store durable operational decisions, root causes, and gotchas. Do not store secrets, Personal facts, biographical details, durable human preferences, transient progress, issue numbers, PR numbers, commit SHAs, or "task done" logs that will be stale in a week. Route human-facing context to Brain with `brain capture`. If the learning is procedural and reusable, update or create a skill instead of storing it as memory.

### 7. Check self-improvement signals

When Skill telemetry is enabled, inspect it before curating:

```bash
node "${CLAUDE_PLUGIN_ROOT}/../memory/scripts/bootstrap.mjs" status skills --root .
node "${CLAUDE_PLUGIN_ROOT}/../memory/scripts/bootstrap.mjs" curate skills --root .
```

`memory curate skills` is report-only. Mutating workflow stays in `/curate`, which archives only Curatable skills after explicit approval and can restore them. Never auto-delete skills.

### 8. Report the context posture

Before moving into implementation, summarize:

- Committed context read: files/ADRs consulted.
- Memory posture: absent / markdown-only / graph ready / graph stale / recall hits used.
- Wiki posture: absent / queried / updated.
- Codebase map: key modules and edges relevant to the task.
- Self-improvement posture: no action / store facts / update skill / run curator.

Keep this summary concise. The goal is to prove the agent is grounded, not to dump every artifact.

### 9. End-of-session doc-landing finalizer

When the context session ends, run the shared end-of-session doc-landing finalizer in [`/start`'s DOC-LANDING-FINALIZER.md](../start/DOC-LANDING-FINALIZER.md) before exiting.

## Hard rules

- Do not let graph or memory output outrank the current worktree.
- Do not dump raw nodes, edges, recall hits, or path listings as the final answer; interpret them into project terms.
- Do not write Memory/Wiki/Skill state from a read-only analysis unless the user asked for that side effect.
- Do not commit `.red/wiki/`, `.red/memory/graph.rdb*`, generated graph exports, or private memory notes unless the project explicitly made them committable.
- Prefer one focused context refresh over repeated broad searches.

</what-to-do>

<supporting-info>

## Choosing the right surface

| Need | Surface |
|------|---------|
| Current repo rules and vocabulary | `CLAUDE.md` / `AGENTS.md`, `.red/CONTEXT.md`, `.red/adr/` |
| Prior decisions/gotchas | `/memory:recall` |
| Code structure and impact | `/memory:ingest`, graph reads, `/zoom-out` |
| External docs/research/source synthesis | `/wiki ingest`, `/wiki query` |
| Durable operational work fact | `/memory:store` |
| Personal fact or human-facing context | `brain capture` / `/brain:capture` |
| Reusable procedure | update/create a `SKILL.md` |
| Skill lifecycle maintenance | `memory status skills`, `memory curate skills`, `/curate` |

## Common outcomes

- **Cold repo:** run `/red-setup`, then `/wiki-init` only if the repo needs a private knowledge base, then `memory init --mode graph` when persistent graph recall is worth the local RedDB store.
- **Large code change:** recall prior decisions, ingest if graph is stale, zoom out around the target, then drill down.
- **Repeated agent failures:** recall prior attempts/root causes, inspect Skill telemetry, update the failing skill or file a human-ready curator issue.
- **Research-heavy project:** ingest sources into the wiki, create synthesis pages, store only stable operational decisions/gotchas in Memory, and capture Personal facts or human-facing context in Brain.

</supporting-info>
