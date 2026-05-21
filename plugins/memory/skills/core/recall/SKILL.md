---
name: recall
description: Search the project's persistent memory and return matching notes, ranked by relevance. Use when the user asks "what do we know about …", "did we decide …", "have we seen this before", "/memory:recall …", or when you want past decisions/gotchas before acting. Requires `memory init` to have run.
---

# memory recall

Full-text search over the markdown notes stored by `/memory:store`. Returns the
matching notes ranked by how strongly they match the query — the zero-token read
path, no LLM extraction.

<what-to-do>

## 1. Require init

If `.red/memory/config.json` is missing, memory was never initialized — there is
nothing to recall. Suggest `/memory:init`.

## 2. Recall

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" recall <query terms>
```

Everything after `recall` is the query. Add `--limit N` to cap results
(default 10).

## 3. Use the hits

Read the returned notes and fold what's relevant into your answer or your next
step — cite the fact, don't just dump the list. If there are no matches, say so
plainly rather than guessing.

## DOs / DON'Ts

- ✅ Recall before re-deriving something the project may already know.
- ✅ Treat a recalled note as a claim made at store time — verify it still holds before relying on it.
- ❌ Don't assume an empty result means the fact is false — it may just be unstored.

</what-to-do>
