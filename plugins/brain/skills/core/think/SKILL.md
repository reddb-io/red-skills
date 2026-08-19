---
name: think
working-mode: interactive
description: Synthesize a cited answer from the project Brain — deterministic over captured artifacts with confidence and evidence gaps stated. Use when the user asks what Brain knows, how ideas connect, what supports or contradicts something, or what changed. Routes to Brain, not Memory.
---

# brain think

Synthesizes a cited answer from the project Brain store. Unlike `/brain:search`, which returns a raw ranked hit list, `brain think` calls `brain_think` and returns a **grounded, cited answer** with an explicit confidence level and stated evidence gaps — no gap-filling from uncited model knowledge.

Brain think reasons over **human and project knowledge** captured in Brain. It does not read the Memory operational-evidence store. For questions that need both personal context (Brain) and engineering work facts (Memory), run `/brain:think` first, then `/memory:recall`, and synthesize manually — citing which store each piece of evidence came from.

<what-to-do>

**Call `brain_think` with the user's question, deliver the cited answer as-is, state the confidence and evidence gaps, and never fill missing evidence with model knowledge.**

## 1. Choose `brain think` vs `brain search`

- Use **`brain think`** when the user wants a synthesized answer with citations: "what do we know about X?", "what does Brain say about Y?", "how does A connect to B?", "does Brain support or contradict Z?", "what changed?"
- Use **`brain search`** (`/brain:search`) when the user wants the raw ranked hit list to browse, or needs to inspect individual artifacts before any synthesis.

## 2. Call `brain_think`

Call the `brain_think` MCP tool when available:

```json
{
  "query": "<the user's question as a natural-language query>"
}
```

Otherwise run:

```bash
node "${CODEX_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/scripts/bootstrap.mjs" think "<query>"
```

Pass the user's question as-is. The synthesis is deterministic over Brain search results — do not paraphrase the query unless it is genuinely ambiguous.

## 3. Deliver the result

`brain_think` returns four fields — present all of them:

- **`answer`** — a concise cited answer grounded in Brain artifacts. Present this to the user directly.
- **`citations`** — stable refs to the artifact `rid`/`id`/`kind`, score signals, excerpts, and captured source provenance. List them so the user can navigate to the source artifacts.
- **`confidence`** — `none`, `low`, `medium`, or `high`, derived from the ranking signals. State the level explicitly.
- **`missing_evidence`** — explicit gaps: no hits, weak hits, only one citation, or artifacts without source provenance. Read these gaps aloud rather than silently ignoring them.

## 4. State what Brain does not know

When `confidence` is `none` or `low`, or `missing_evidence` is non-empty:
- State what Brain does not know instead of filling the gap from model knowledge.
- Suggest `/brain:capture` to store the missing knowledge if the user wants it available for future recalls.
- Never present uncited model knowledge as if it came from Brain.

## DOs / DON'Ts

- ✅ Prefer `brain think` over freeform synthesis when the user asks what Brain knows.
- ✅ Present citations alongside the answer so the user can verify the source.
- ✅ State `confidence` and all `missing_evidence` items explicitly.
- ❌ Don't fill evidence gaps with uncited model knowledge — state what Brain does not know.
- ❌ Don't use `brain think` for operational work facts from the current session — use `/memory:recall` for those.
- ❌ Don't skip citations and deliver a bare answer — the cited, grounded form is the point.

</what-to-do>

<supporting-info>

### `brain_think` output fields

| Field | Type | What it means |
|---|---|---|
| `answer` | string | Cited synthesized answer grounded in Brain artifacts |
| `citations` | list | Artifact `rid`/`id`/`kind`, score signals, excerpt, provenance |
| `confidence` | enum | `none` \| `low` \| `medium` \| `high` |
| `missing_evidence` | list | Explicit gaps — no hits, weak hits, single citation, or missing provenance |

### Confidence derivation

`confidence` is computed from ranking signals returned by `brain_think` — a high-scoring, multi-citation result with source provenance yields `high`; a single weak hit with no provenance yields `low` or `none`. The agent does not choose the confidence level: it is returned by `brain_think` and must be relayed as-is.

### Brain-vs-Memory boundary

See [Brain-vs-Memory boundary](../../references/BRAIN_VS_MEMORY.md).

</supporting-info>
