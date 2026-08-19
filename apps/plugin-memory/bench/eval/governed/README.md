# Governed eval corpus (needle + adversarial)

`corpus.json` + `questions.json` scale the curated benchmark beyond the small
single-hop/structured fixtures to a size where multi-hop and temporal structure
is actually exercised, and add two categories designed so that **correct
governance is the only way to score**. The fixture runs through the same
fixed-pack harness (`runBenchEval`) as the other scenarios, so the substrate
stays the only variable.

## Scenarios

The corpus keeps the single-hop spine, the `multi-hop` typed-relation chains, and
the `temporal-as-of` supersession pair from the structured fixture, then adds a
large distractor set plus the two new categories:

- `needle`: one authoritative fact (`pg_failover_timeout` = 90 seconds) is
  planted among ~18 same-theme database/ops distractor nodes. The question
  carries the gold answer and gold doc id; governed recall must surface the one
  planted fact at rank 1.
- `adversarial`: three cases, each scoring **only** when the matching governance
  axis fires. The decoy in each case is engineered to out-rank the gold under
  raw token overlap, so an ungoverned ranker is fooled:
  - **near-duplicate** (`scope`): two near-identical "request timeout" facts
    differ only by `scope` (`search-api` vs `checkout-api`). The question's
    `scope` filters the wrong-entity decoy.
  - **superseded-but-tempting** (`supersedes`): the old decision carries
    `superseded_by` and more tempting keyword overlap. With no `as_of`, governed
    recall drops the superseded node so the current decision wins.
  - **contradictory-source** (`confidence` / `tier`): a `low`-confidence `chat`
    note contradicts the `high`-confidence canonical decision and has equal raw
    overlap. The governance weight demotes the chat note.

## Governance axes

Corpus entries may carry `scope`, `confidence`, and `tier` (all optional; an
entry without them is a global, full-confidence, canonical fact and ranks exactly
as before). The RedDB governed-recall substrate applies them: scope-filtering,
supersession-at-now, and a confidence/tier ranking weight. The ungoverned
baselines (markdown embedding-RAG, plain Neo4j term traversal, Graphify) do not,
so the adversarial category is where governance shows up as a measurable score
gap.

Run it:

```bash
benchmark-memory bench eval --corpus bench/eval/governed --json
```
