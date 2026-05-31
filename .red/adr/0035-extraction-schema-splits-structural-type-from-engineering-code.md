# Extraction schema splits a closed structural type from an open engineering code

## Context

Studying `neo4j-labs/llm-graph-builder` surfaced schema-guided extraction: a
declared set of types constrains the LLM extractor so the graph stays
consistent. Studying TigerBeetle's data model then sharpened the idea. TigerBeetle
keeps a tiny, closed set of **structural** types (`Account`, `Transfer`,
`Ledger`) but pushes all open, app-defined semantics into a separate `code`
(the "why"/kind) and into indexed `user_data` fields. Structural shape and
semantic classification are deliberately different axes.

The Memory plugin had conflated those axes onto one "node type". The first cut of
this ADR therefore faced a false choice for an LLM-inferred fact whose type was
out of vocabulary: **reject it** (hold it in a `needs-review` quarantine) or
**flatten it** (coerce to a generic `concept`, degrading clusters and digests).
Both are lossy. The conflation was the cause.

The Memory plugin already has the pieces to do better: nodes carry `tags` and a
lossless `metadata` bag (the graph contract's `ContractNode.metadata`,
preserved losslessly), and the export contract is deliberately **open** —
unknown node types are free strings and unknown edge labels round-trip onto
`references`, so "a new label never breaks a consumer".

## Decision

The **Extraction schema** governs provider-backed `memory extract` on two axes
derived from the conflated one:

- **Structural type** — a closed, small axis of node kinds that have distinct
  edge/query/storage behaviour (`file`, `symbol`, `concept`, `issue`, `prd`,
  `attempt`, `validation`, …). The strict-write profile validates this axis.
- **Engineering code** — an open, indexed axis carrying the fine-grained
  semantic classification (the "why"/kind: decision, gotcha, risk, root-cause,
  …), modelled on TigerBeetle's `code`/`user_data`.

The structural vocabulary is shared with the lossless-read graph contract (one
vocabulary, two profiles: strict-write for inference, lossless-read for export),
so export stays permissive while inference stays consistent.

An out-of-vocabulary classification is **never rejected and never quarantined**.
It lands as a free **Engineering code** on a base structural type, so every
inferred fact always has a valid structural home. There is no `needs-review`
quarantine state.

The Engineering code axis is **first-class, not decorative**: it is indexed,
recall may filter and rank by code alongside tier and type, and community
digests and graph communities may group and label by it. This is what
distinguishes the split from plain coercion — the classification stays usable.

The code axis is **controlled-but-growable**: the schema carries a suggested
code vocabulary, unknown codes are admitted, and a **Code drift report**
aggregates unknown codes by recurrence so a recurring code can be promoted into
the suggested vocabulary (or aliased) while one-off noise is aliased or left.

The strict-write gate applies **only** to the provider/`INFERRED` path. The
deterministic zero-token extractors are typed by construction and share the
structural vocabulary as a CI lint, not a runtime gate.

## Alternatives considered

- **Single conflated type axis + quarantine (this ADR's first cut).** Rejected.
  Conflating structural and semantic kinds forces a lossy reject-or-flatten
  choice; quarantine then needs a state, a report, and a drain, and risks
  becoming a cemetery. The split dissolves the dilemma.
- **Single conflated type axis + coerce to generic `concept`.** Rejected — it
  discards the classification and degrades the clusters and digests downstream
  work depends on.
- **Per-project configurable ontology (full llm-graph-builder parity).**
  Rejected. The Memory moat is a consistent, first-class Engineering semantic
  graph across projects; per-project schemas fragment recall, governance, and
  competitive baselines.
- **Fully open code axis (pure TigerBeetle `code`).** Rejected as the default —
  unrestrained codes relocate the synonym-fragmentation problem one axis down
  ("gotcha"/"pitfall"/"footgun"). Controlled-but-growable keeps curation.
- **Code as preserved-only metadata (not indexed).** Rejected — it makes the
  split cosmetic; the classification must stay a real query/ranking dimension.
- **Close the graph contract / use one profile for read and write.** Rejected —
  it breaks the deliberate "export never breaks a consumer" guarantee.

## Consequences

- "Node type" becomes two axes. The closed structural vocabulary is the
  source of truth for the strict-write and lossless-read profiles; the
  Engineering code axis is open, indexed, and curated.
- `memory extract`'s provider path validates only the structural type and
  always assigns a valid structural home, so it never rejects or quarantines;
  the deterministic path gains a CI lint over the structural vocabulary.
- There is **no quarantine / `needs-review` state**. Low-confidence-of-truth
  remains handled by the `INFERRED` tier plus decay/governance, independent of
  typing.
- A **Code drift report** replaces the former quarantine report: it surfaces
  recurring unknown codes for promotion or aliasing; it is visibility, not a
  gate, and never excludes facts from recall.
- Recall ranking gains `code` as a deterministic feature alongside tier and
  type — consistent with ADR 0022 (no LLM/vector dependency enters the canonical
  ranking).
- Community digests and graph communities may group and label by code, which
  improves the digest/global-search work (this ADR is upstream of it).
- Downstream consumers of `graph.json#contract` are unaffected: the read profile
  stays lossless.
