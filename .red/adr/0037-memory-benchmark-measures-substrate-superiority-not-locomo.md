# Memory benchmark measures substrate superiority on a curated engineering corpus, not LOCOMO

## Status

accepted.

## Context

The market benchmarks agent memory on **LOCOMO** (long-term *conversational* QA),
reporting an LLM-as-judge "J" score and a "~90% fewer tokens vs full-context"
headline (mem0, Zep, Letta, cognee). Adopting that path would make our numbers
nominally comparable to theirs.

But our Memory plugin is **operational/engineering memory** — decisions, gotchas,
the code graph, issues/PRDs/attempts — not chat memory. LOCOMO measures a use case
we are not for. And our stated win condition is twofold: (1) be **useful** to
engineering agents, and (2) **showcase that RedDB structures the data better than
the alternatives a team actually chooses** — principally plain **markdown notes**
and **neo4j**. That is a *substrate* claim (how the data is organised/stored/
retrieved), not a chat-QA-accuracy claim.

A second trap: neo4j is *also* a graph, so "graph beats flat markdown" proves only
the easy half. The hard, honest claim ("RedDB beats neo4j") needs a *specific*
capability neo4j (plain) lacks.

We already have unusual infrastructure for this: `competitive-baseline.ts` +
`live-baseline-adapters.ts` can run a competitor's CLI **live** on the same fixtures
(a neo4j-agent-memory adapter and a checked graphify baseline already exist), and
`../reddb` ships a real analytics module (hypertables, histograms, gauges,
continuous-aggregates, percentiles — and a prior `CI benchmark stats p50-p99 vs
redis baseline` precedent).

## Decision

The Memory benchmark evaluates **substrate superiority** — RedDB-graph + governed
recall vs **markdown + best-effort RAG** vs **neo4j + native traversal** — on a
**curated engineering corpus**, reporting **quality-per-token**. Not LOCOMO.

- **Unit:** QA over the engineering corpus; each substrate retrieves its own way,
  the same answerer model answers, the same scorer scores → the *substrate* is the
  only variable.
- **Corpus:** hand-authored, small and dense to start, with deliberately *planted*
  multi-hop chains, temporal supersessions, and unanswerable cases, with **exact
  gold**. Generate-and-verify scales it later; real-repo dogfood is the
  external-credibility phase.
- **Baselines are steelmanned and run LIVE on the identical corpus** — markdown gets
  real embedding-RAG, neo4j gets real traversal, graphify runs its CLI. Published
  competitor numbers are a cross-check only, never a substitute (different corpora
  are not comparable — the mem0-vs-Zep failure).
- **Scoring:** deterministic exact-match/F1 is the primary, reproducible number;
  a frozen LLM-judge "J" is a secondary, market-comparable headline for open-ended
  questions. Pin the answerer + judge model versions.
- **Telemetry:** full per-question metrics — tokens in, tokens out, time-to-response,
  tools used, reasoning-vs-prompt ratio, quality — captured in an **agent-driven**
  tier (the realistic loop) with a **fixed-pack** tier for clean substrate isolation.
- **The RedDB-vs-neo4j differentiator is explicit:** corpus categories isolate the
  three things plain neo4j lacks — **as-of/temporal** versioning (ADR 0024), the
  **two-axis structural-type/engineering-code schema** (ADR 0035), and **governed
  recall + abstention** (strict-write). The per-category breakdown maps directly to
  "here is what neo4j cannot do".
- **Storage:** raw JSONL records (portable, reproducible, CI-independent) **plus** the
  RedDB analytics layer (hypertable time-series, histograms, percentiles,
  continuous-aggregate regression) — a recursive showcase: RedDB structures the
  benchmark's own data.
- **Cadence is tiered:** a cheap deterministic core (exact-match / fixed-pack) gates
  every memory change and feeds the regression hypertable; a periodic heavier tier
  (agent-driven, ≥10 runs where variance lives, all live) produces the marketing
  showcase + the J-score.
- **Headline:** "X% fewer tokens at Y% of full-context quality, and better than RAG /
  neo4j on multi-hop / temporal / abstention" — quality-per-token on a *stated*
  baseline, never "better and cheaper" unqualified.

## Alternatives considered

- **LOCOMO-first (market-comparable).** Rejected as the spine: it measures
  conversational chat memory, not our engineering domain, so a good LOCOMO number
  would not prove our actual value. May be run later purely for a comparability
  footnote.
- **Cited competitor numbers instead of live baselines.** Rejected: numbers from
  different corpora are not comparable; only a shared-corpus live run is credible.
- **LLM-judge for everything.** Rejected as primary: judge variance/drift is the
  field's #1 reproducibility tell; we lean on exact gold where the curated corpus
  gives it and reserve the frozen judge for the open-ended slice.
- **Aggregate-only reporting.** Rejected: it hides *where* the substrate wins (and
  full-context can win the aggregate while RedDB wins the structural categories);
  including adversarial cases in an aggregate denominator is exactly what inflated
  Zep's retracted LOCOMO number.
- **Fixed-pack injection only.** Rejected as the spine: it cannot capture the
  tools-used / reasoning-ratio / latency telemetry; kept as the isolation tier.

## Consequences

- The benchmark proves a domain-relevant, substrate-specific claim our users care
  about — at the cost of not being head-to-head comparable to mem0/Zep's LOCOMO J.
- The corpus is the long pole: its planted structure (multi-hop, temporal,
  unanswerable) is what makes the RedDB-vs-neo4j win visible; a flat corpus proves
  nothing (the current 6-node `memory-moat-claims` fixture cannot showcase
  structure).
- Standing up live neo4j + markdown-RAG + graphify on the shared corpus is real
  infrastructure work, but it is the only credible path.
- The benchmark becomes a living, regression-gated artifact (not a one-off), and it
  doubles as a RedDB-analytics dogfood.
