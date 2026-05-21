---
name: store
description: Save a fact to the project's persistent memory as a plain markdown note. Use when the user says "remember this", "store that …", "/memory:store …", or when you want a decision, gotcha, or why-note to survive across sessions. Requires `memory init` to have run.
---

# memory store

Saves one fact to the project's memory and routes to whatever `memory init`
configured. In **markdown-only** mode it writes a markdown note under
`.red/memory/notes/` — the note **is** the canonical store, human-readable and
committable. In **graph** mode it writes a deduped `concept` node to the RedDB
store (storing the same fact twice returns the same node). Either way the fact
is recallable later with `/memory:recall`. Nothing else fires.

<what-to-do>

## 1. Require init

If `.red/memory/config.json` is missing, memory was never initialized — run
`/memory:init` (or tell the user to) before storing.

## 2. Store the fact

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" store <the fact text>
```

Pass the fact as the argument (everything after `store` is joined into one
note). The CLI writes `<timestamp>-<slug>.md` with YAML frontmatter and the fact
as the body, and prints the note path.

## 3. Confirm

Report the note id/path so the user knows what was captured.

## DOs / DON'Ts

- ✅ Store a single, self-contained fact per call (a decision, a gotcha, a why-note).
- ✅ Capture the *why*, not just the *what*, when the user is explaining a decision.
- ❌ Don't store secrets — notes are plain text on disk and may be committed.
- ❌ Don't hand-write files into `notesDir` — go through the CLI so ids and frontmatter stay consistent.

</what-to-do>
