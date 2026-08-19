---
name: recall
working-mode: interactive
description: Search the project's configured memory surface and return governed context ranked by relevance. Use when the user asks "what do we know about …", "did we decide …", "have we seen this before", "/memory:recall …", or when you want past decisions/gotchas before acting. Requires `memory init` to have run.
---

# memory recall

Searches the project's memory for facts stored by `/memory:store`, ranked by how
strongly they match the query — the zero-token read path, no LLM extraction. In
**markdown-only** mode it full-text-searches the notes; in **graph** mode it runs
the governed recall engine — deterministic text seeds expanded through the graph
neighborhood, ranked with tier/trust/recency/centrality, hiding superseded nodes
behind the current head of a `SUPERSEDED_BY` chain. Vector hits can contribute
when a vector provider/projection is explicitly ready, but recall is not
vector-first. Routing follows `memory init`. Graph mode also exposes
`search`/`neighbors`/`traverse`/`path`/`stats` read verbs, MCP (`memory-mcp`),
HTTP, context-pack, readiness, claim-check, and Workbench diagnostics; see the
plugin README.

<what-to-do>

**Search the memory graph for facts matching the query and fold the ranked hits into your answer — do not re-derive what the project may already know.**

## 1. Require init

If memory is not configured — see [Memory preconditions](../../references/PRECONDITIONS.md) — there is nothing to recall; suggest `/memory:init`.

## 2. Recall

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" recall <query terms>
```

Everything after `recall` is the query. Add `--limit N` to cap results
(default 10).

## 3. Use the hits

Read the returned evidence and fold what's relevant into your answer or your
next step — cite the fact, don't just dump the list. Treat recall as a governed
context candidate set: verify stale/high-impact claims before relying on them.
If there are no matches, say so plainly rather than guessing.

## DOs / DON'Ts

- ✅ Recall before re-deriving something the project may already know.
- ✅ Treat a recalled note as a claim made at store time — verify it still holds before relying on it.
- ❌ Don't assume an empty result means the fact is false — it may just be unstored.

</what-to-do>
