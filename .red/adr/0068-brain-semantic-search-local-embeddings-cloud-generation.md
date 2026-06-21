# Brain semantic search uses local-first embeddings on a separate lane from cloud generation

## Status

accepted.

Relates: [ADR 0063](0063-brain-plugin-is-the-third-red-skills-context.md) (the `brain` plugin),
[ADR 0038](0038-dev-runtime-ships-as-a-fetched-asset-not-a-committed-bundle.md) / [ADR 0040](0040-version-is-single-source-one-writer-version-aware-clis.md) (fetched bundle + version model that constrains how the embedder ships),
[ADR 0060](0060-root-apps-packages-with-pnpm-catalog.md) (the `apps/brain` / `packages/*` layout the shared embedder will later land in),
[ADR 0041](0041-red-skills-consumes-red-memory-and-red-ui-mcps.md) (the lift-to-shared / cross-plugin precedent for memory reuse).

## Context

`brain search` scores artifacts on lexical matches, tags, artifact kind, and
graph connections, with a `vector` slot in the `score_breakdown` that is
**reserved but hardcoded to `0`** (`apps/brain/src/store.ts`). Brain is, in
effect, a Level‑1/2 keyword+graph retriever wearing Level‑4 (typed knowledge
graph) clothing. The felt symptom is that brain "seems dumb" — it whiffs when a
question is phrased with different words than the artifact was captured with,
which is exactly the recall-precision failure semantic search exists to fix.

Lighting up that slot forces several non-obvious calls, because brain holds
**personal and business knowledge** (its whole identity, per ADR 0063) and ships
as a fetched single-file bundle (ADR 0038), not a `node_modules` tree. RedDB has
no native vector/ANN surface, and the existing `AiProviderConfig` seam (shared
with `memory`) is a *generation* (`complete`) seam, not an embeddings seam.

## Decision

1. **Two provider lanes, different defaults.** *Generation* (LLM reasoning) stays
   **cloud-default**, OpenAI primary. *Embeddings* are **local-first** — a small
   open-source HuggingFace model in the all‑MiniLM class (~384‑dim), OpenAI
   embeddings as the documented second option. Embeddings run on *everything
   captured* (high volume, privacy-heavy, cheap); reasoning runs occasionally and
   benefits from cloud quality. They are separate config surfaces, not one knob.

2. **Embeddings execute in-process via `transformers.js`** (`@huggingface/transformers`),
   ONNX MiniLM. The model weights do **not** live in the launcher bundle: first
   use lazily downloads + caches them (e.g. `~/.cache/red-skills/embeddings/`).
   When no model is reachable or a download fails, search **degrades to
   lexical-only** — never a hard error.

3. **No native vector store; cosine in-process.** The vector is computed at
   *capture* time and stored on the artifact (`store.ts`'s existing `vector`
   field); search brute-forces cosine into the reserved slot. Adequate at
   project-brain scale (hundreds–low-thousands of artifacts); not an ANN index.

4. **The embedding unit is a deterministic per-artifact excerpt** — `title +
   tags + lead` assembled **locally, with no LLM call**. A *generated* summary
   would route private artifact content to the cloud generation lane on every
   capture, undoing the privacy posture; a deterministic excerpt keeps capture
   local, instant, and free. Brain artifacts are meant to be atomic, so the
   title+lead is a strong vector; an artifact too long to embed faithfully is a
   *capture-granularity* smell, not a retrieval bug.

5. **Vector is a recall-expander first, a ranking term second.** v1: vector pulls
   in semantically-near artifacts that lexical missed so they become *eligible*;
   lexical+graph still ranks. It graduates to a normalized weighted blend once
   golden-question eval data exists to tune weights. This targets the observed
   failure (recall misses) with minimal disturbance to current ordering, and
   avoids freezing hand-picked weights before there is data.

6. **Brain-first, then lift to a shared package.** Memory `recall` has the
   identical lexical+graph limitation, but there is zero working semantic code
   today. Prove it in brain, then extract the embedder + cosine helper into a
   `packages/*` library memory consumes (ADR 0041 reuse precedent). Pure
   shared-first risks freezing an unvalidated contract.

7. **Success is measured, not eyeballed.** A small brain eval harness (15–30 real
   golden questions, each with the artifact(s) that should return; reuse memory's
   `bench-recall` shape) makes "dumb → not dumb" objective and produces the data
   that tunes decision 5.

## Why

- The local/cloud split is privacy-driven: embeddings touch *all* captured
  private knowledge, so they stay local; reasoning is occasional and wins from
  cloud quality. Collapsing the lanes would leak the former to protect the
  latter's convenience.
- Deterministic excerpts keep *capture* local and instant — and capture is
  itself a known pain, so any per-capture cloud latency/cost would suppress the
  ingestion brain needs to grow.
- Recall-expander-before-blend and golden-question eval both refuse to ship
  guessed weights: the video that prompted this work warns pure semantic search
  whiffs too, so the structured signals (tags/kind/graph) that differentiate
  brain from a flat vector store must keep ranking until eval says otherwise.
- Brain-first-then-lift de-risks the embedding contract that `memory` will
  inherit.

## Consequences

- A future agent must **not** "fix" the privacy split by routing embeddings to
  the cloud generation provider, nor replace the deterministic excerpt with a
  generated summary, without superseding this ADR — both silently send private
  brain content off-box.
- Existing artifacts need a one-time backfill embedding pass; capture embeds
  going forward.
- Long artifacts lose interior detail from semantic search by design; if real
  golden-question eval shows interior-detail misses, the remedy is finer capture
  (or a later parent+child chunking ADR), not abandoning the excerpt unit.
- Capture density and the capture-friction problem are explicitly **out of
  scope** here (brains are dense enough today for retrieval to be felt); they
  remain a separate future effort.
