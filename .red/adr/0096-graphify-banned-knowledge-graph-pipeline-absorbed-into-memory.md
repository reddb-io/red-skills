# graphify is banned; the knowledge-graph pipeline is absorbed into the memory plugin, staged by evidence

## Status

Accepted. Sibling of ADR 0095 under the same house pattern: study an external tool, absorb its concepts under our own names, retire the original. Vocabulary note: per ADR 0089's "no source-repo names" rule, the absorbed capabilities are named by what they do (corpus ingest, community analysis, graph report), never after the source.

## Context

graphify — a third-party corpus→knowledge-graph CLI driven by a user-level skill — was studied alongside RTK and the external context-optimization layer during the 2026-07-09/10 elision-program grilling. Its audit-trail vocabulary (EXTRACTED / INFERRED / AMBIGUOUS with confidence bands) had **already** been absorbed into the memory plugin long before the study, and its community detection duplicates what the local RedDB engine provides natively (Louvain, engine-side, no Python dependency).

Measured local usage: **one run** (2026-04-24, a 44-file code corpus in `reddb-benchmark`). The multimedia lanes (video/audio transcription, image vision), URL ingestion, and five of its six exporters were never exercised on this machine.

## Decision

1. **Banned now.** The user-level skill, the pip package, its binary, and the global `CLAUDE.md` trigger were removed on 2026-07-10. Unlike RTK there was no ongoing saving to preserve during a transition — the tool was inert unless invoked — so the ban does not wait for replacement parity. Historical outputs remain on disk as static data.
2. **The memory plugin absorbs the corpus→knowledge-graph pipeline, 100% committed, staged by evidence.** The Spec carries the full capability inventory as a commitment (no scope re-litigation later), but slices land in usage order:
   1. **Graph pipeline** — corpus ingest for code/docs with structural (AST) + semantic extraction and audit seals, on the existing `memory:ingest`/`export` base and the Repo store;
   2. **Analysis** — high-degree hub detection, cross-community bridge detection, exposed cohesion scores, community labeling, suggested questions, and the answer-becomes-a-node feedback loop, all over the engine-native Louvain;
   3. **URL/PDF ingestion**;
   4. **Multimedia lanes and additional exporters** — last, and each lane activates only when a real use case exists, mirroring the rsp admission rule (ADR 0095: a surface earns activation by measurement/need, never by existing).
3. **Community detection stays engine-native.** RedDB's Louvain is the clustering authority; no Python graph stack is introduced for a marginal algorithm preference.

## Consequences

- `/graphify` no longer exists on this machine; asking for a knowledge graph of a corpus routes to the memory plugin's surfaces as the slices land.
- The memory-evolution Spec inherits the staged inventory above; slice 1 builds on ingest/export/Louvain/seals that already exist, so parity on the exercised surface is the shortest path, not a rewrite.
- If a need arises in the gap between ban and a lane's slice, that need *is* the use-case evidence the lane's activation requires.
