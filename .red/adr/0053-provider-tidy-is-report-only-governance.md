# Provider tidy is report-only governance until an explicit soft-merge approval

## Status

Accepted. The output of provider-backed tidy is non-canonical; graph mutations require explicit soft-merge approval gating. Implementation lives in the `red-memory` repo as of ADR 0041 spin-off.

## Decision

Provider-backed tidy may help Memory find duplicate or near-duplicate evidence, but its output is not canonical graph evidence. Memory persists tidy results as non-canonical provider review artifacts keyed by a fingerprint over the relevant nodes/edges plus operation and review-policy version; `memory governance` reports those recommendations read-only and degrades to deterministic output when provider tidy is unavailable. A recommendation affects governed recall only after an explicit mutating workflow accepts it and creates an approval-gated `SAME_AS`/`MERGED_INTO` Soft-merge edge.

This keeps Odysseus-style conservative tidy useful without letting provider output silently collapse the RedDB Memory graph, bypass provenance, or turn governance into a mutating surface.
