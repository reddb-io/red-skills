---
name: search
working-mode: interactive
description: Search Brain artifacts for captured knowledge before answering questions about prior captures, decisions, people, open questions, or plans. Use when the user asks "what do we know about X", "search the brain", or "find what was captured about Y". Routes to Brain, not Memory.
---

# brain search

Searches the project Brain store for knowledge artifacts that match a query — past decisions, open questions, people, ideas, plans, sources, and any other captured content. Use this before answering questions that depend on what has been captured rather than on model knowledge or code.

Brain search is the read path for **human and project knowledge**. For **operational work facts** from an engineering session (gotchas, why-notes, validated approaches), use `/memory:recall` instead. When unsure which store to search, search Brain first; if Brain returns weak or no hits, search Memory for operational evidence.

<what-to-do>

**Search Brain before answering any question that depends on prior captured knowledge. Interpret the hits, state what was found, and tell the user what Brain does not know.**

## 1. Decide whether to search Brain

Search Brain when the question is about:
- A person, organization, or contact previously captured
- A past decision, idea, or plan
- An open question or hypothesis stored in Brain
- A concept, pattern, or source the user asked to remember
- What the user told the agent to recall across sessions

Search Memory (`/memory:recall`) instead when the question is about:
- A code-level decision, gotcha, or why-note from engineering work
- A validated approach or tool choice from a work session
- Operational evidence about the current project's engineering behavior

If both stores may hold relevant hits (a decision with both personal context and a code rationale), search both and synthesize, citing which store each hit came from.

## 2. Search

Call the `brain_search` MCP tool when available:

```json
{
  "query": "<natural-language search query>",
  "limit": 10
}
```

Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" search "<query>"
```

Use a natural-language query. The search engine ranks results using lexical matches, tags, artifact kind, graph connections, and a reserved vector slot — all exposed via `score_breakdown`.

## 3. Interpret the hits

- Read the top hits and their `score_breakdown`.
- Cite the artifact `id`, `kind`, and `title` when reporting results to the user.
- Use `score_breakdown` to explain why a hit ranks high when the user asks about relevance.
- Treat a hit as a **claim made at capture time** — verify it still holds before relying on it for high-stakes actions.

## 4. Handle empty or weak results

If no hits return, or all hits are low-scoring:
- Say plainly that Brain has no captured knowledge about the query.
- Do not fill the gap with model knowledge and present it as if it came from Brain.
- Suggest `/brain:capture` to store the missing knowledge if the user wants it available for future searches.

## DOs / DON'Ts

- ✅ Search Brain before answering questions about people, decisions, ideas, and plans.
- ✅ Cite artifact ids and kinds in your answer so the user can reference them.
- ✅ Use `score_breakdown` to explain relevance when asked.
- ❌ Don't substitute model knowledge for Brain hits when results are empty — say what Brain does not know.
- ❌ Don't search Brain for operational work facts from the current session — use `/memory:recall` for those.
- ❌ Don't skip the search and synthesize from model knowledge alone when the user asks what Brain knows.

</what-to-do>

<supporting-info>

### Score signals in `score_breakdown`

Current ranking signals:
- Lexical matches on title and content
- Tag overlap
- Artifact kind match (if the query references a kind)
- Graph connections (neighbor boost from linked artifacts)
- Reserved vector slot (not yet active)

### Brain-vs-Memory boundary

See [Brain-vs-Memory boundary](../../references/BRAIN_VS_MEMORY.md).

### When to use `brain think` instead

`brain search` returns the raw ranked hit list. Use `/brain:think` when the user wants a **synthesized cited answer** drawn from multiple hits — `brain think` calls `brain_think`, which runs search internally and returns a grounded answer with confidence and evidence gaps.

</supporting-info>
