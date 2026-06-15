---
name: think
description: Synthesize an answer from the project Brain.
---

# Think Skill

Use this when the user asks what the project Brain knows, what changed, what
supports or contradicts an idea, or how captured knowledge connects.

Call `brain_think` when MCP is available. The synthesis is deterministic over
Brain search results and returns:

- `answer` - a concise cited answer suitable for the user.
- `citations` - stable refs back to Brain artifact rid/id/kind, score signals,
  excerpts, and captured source provenance.
- `confidence` - `none`, `low`, `medium`, or `high`, derived from the returned
  ranking signals.
- `missing_evidence` - explicit gaps when Brain has no hits, weak hits, only one
  citation, or artifacts without source provenance.

Prefer the cited answer over freeform synthesis. If `confidence` is `none` or
`missing_evidence` is non-empty, say what Brain does not know instead of filling
the gap from general model knowledge.
