---
name: store
working-mode: interactive
description: Save one durable work fact to the project's configured memory surface. Use when the user says "remember this", "store that …", "/memory:store …", or when you want a scoped decision, gotcha, validation, or why-note to survive across sessions. Requires `memory init` to have run.
---

# memory store

Saves one fact to the project's memory and routes to whatever `memory init`
configured. In **markdown-only** mode it writes a markdown note under
`.red/memory/notes/` — the note **is** the canonical store, human-readable and
committable. In **graph** mode it writes a deduped node to the RedDB store
(storing the same fact twice returns the same node) with the
metadata needed for governed recall, freshness, and later supersession. Either
way the fact is recallable later with `/memory:recall`.

<what-to-do>

**Save one fact to the project memory — a decision, a gotcha, or a why-note — and confirm the stored identity so the user knows what was captured.**

## 1. Require init

If memory is not configured — see [Memory preconditions](../../references/PRECONDITIONS.md) — run `/memory:init` before storing.

## 2. Store the fact

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" store <the fact text>
```

Pass the fact as the argument (everything after `store` is joined into one
note). The CLI routes by config. Markdown-only writes `<timestamp>-<slug>.md` with YAML
frontmatter and the fact as the body. Graph mode prints the stored/deduped node
identity and keeps the durable evidence in `.red/memory/graph.rdb`.

## 3. Confirm

Report the note path or graph node id so the user knows what was captured.

## DOs / DON'Ts

- ✅ Store a single, self-contained fact per call (a decision, a gotcha, a why-note).
- ✅ Capture the *why*, not just the *what*, when the user is explaining a decision.
- ❌ Don't store Personal facts (biographical details, identity context, long-lived human preferences) in Memory — see [Brain-vs-Memory boundary](../../../../brain/skills/references/BRAIN_VS_MEMORY.md) and route to `brain capture` instead.
- ❌ Don't store secrets — notes are plain text on disk and may be committed.
- ❌ Don't hand-write files into `notesDir` — go through the CLI so ids and frontmatter stay consistent.

</what-to-do>
