# Vector is a seed provider for Memory recall

## Status

accepted.

## Context

The Memory moat foundation includes vector/hybrid recall so the Memory plugin
can compete with coding-agent memory systems that advertise BM25 + vector +
graph retrieval.

The Memory plugin already has a zero-token recall engine that seeds by text,
expands through graph neighborhoods, filters by scope, hides superseded nodes by
default, and ranks by relevance, importance, recency, graph centrality, and
tier weight. That behavior encodes the product's operational-memory discipline:
retrieval should surface applicable, current, trustworthy project memory, not
only semantically similar text.

## Decision

Vector retrieval is a seed provider for Memory recall.

Initial hybrid recall combines textual seeds, vector-similarity seeds, and graph
expansion. The final ranking remains owned by the Memory recall engine and keeps
tier, scope, provenance, supersession, recency, and graph-centrality semantics.

Vector similarity improves candidate coverage. It does not become the primary
source of truth for ordering or applicability.

Embeddings use RedDB's native embedding/vector capability when an AI provider
API key is configured in the engine. Graph mode does not require that key. When
the provider is unavailable, Memory recall degrades to the existing text + graph
path and reports vector retrieval as unavailable instead of failing the recall.

The implementation embeds `MemoryNode` text and ingested document chunks by
maintaining a `memory_vectors` projection. Node vector records mirror searchable
node text (`title`, `summary`, `content`, and `tags`) and carry metadata such
as `node_rid`, `source_hash`, and provider/model information. Document vector
records mirror `memory_docs` chunks and carry `doc_rid`, `path`, title, and
hash metadata so vector readiness can prove documentation coverage. RedDB owns
embedding generation and vector search through its native `WITH AUTO EMBED` /
`SEARCH SIMILAR TEXT` / vector surfaces. Governed recall uses vector hits only
when they recover linked `node_rid` values or can be grounded through a document
hash to the ingested markdown root node. Ungrounded document vector hits remain
readiness/ASK substrate and are skipped by recall.

Node/doc writes remain resilient: a memory write must not fail only because
embedding is unavailable or failed. Explicit vector maintenance commands may be
strict so benchmarks and preparation workflows can require a complete vector
projection.

## Alternatives considered

- **Vector-first recall.** Rejected because it would optimize for semantic
  similarity over operational applicability. It would make durable decisions,
  reasoning traces, ephemeral session memory, branch-scoped facts, and
  superseded guidance harder to govern consistently.
- **Separate semantic-recall command.** Deferred because it splits agent
  behavior into two recall surfaces and makes MCP/API users choose between
  "current governed memory" and "semantic memory". A separate diagnostic command
  may still be useful later, but the default recall path should become hybrid.

## Consequences

- The vector implementation must plug into the existing recall pipeline as an
  additional seed source.
- The implementation must call RedDB's native embedding/vector surface instead
  of introducing a separate embedding database or ad hoc vector store.
- `memory_vectors` is the persistence boundary for node and document-chunk
  embeddings; graph nodes stay graph-shaped and lightweight.
- Document/chunk vectors prove long ADR/context/code documentation coverage, and
  they may enter governed recall ranking only after the doc hit is grounded to
  an applicable Memory node by hash.
- The no-provider path must be explicit and testable: vector seeds are skipped,
  recall still succeeds, and status/reporting says vector retrieval was
  unavailable.
- Write paths are best-effort for embedding. Explicit vector refresh/prep paths
  may fail strictly when the caller asks for vector readiness.
- Ranking tests must prove that vector-only matches can enter the candidate set
  while scope, tier, supersession, and trust semantics still affect final output.
- Public claims should describe hybrid recall as "text + vector + graph under
  governed Memory ranking", not as vector search alone.
