# Zoom-out grows impact analysis by composing graph primitives

## Status

accepted.

Graphify and Understand Anything make codebase maps useful by answering
change-impact and path questions over a project graph. RedSkills already has a
**Codebase understanding surface** in `dev` and graph primitives in the Memory
plugin (`recall`, `neighbors`, `path`, traversal/export evidence). The open
question is whether impact analysis should become a new skill or a deeper
`zoom-out` contract.

## Decision

`zoom-out` grows an impact-aware mode instead of introducing a separate
`impact` skill in the first slice.

When the user's focus is a file, symbol, module, skill, or concept, the
**Zoom-out answer** may include an explicit **Impact** section between
Relationships and Critical Paths. That section separates:

- **Structural impact** — imports, calls, contains, uses-type, docs links, and
  other code/document graph edges.
- **Observed impact** — Reasoning attempts, files touched together, repeated
  failures, retries, and validations.

The first implementation composes existing graph/read primitives:

- `memory_neighbors`
- `memory_path`
- `memory_recall`
- export/list-edge evidence where needed
- ordinary file reads and verification against the current worktree

No dedicated `memory_impact` primitive is introduced yet. That primitive may be
added later if the composed heuristics stabilize and prove useful across repos.

## Why

- **`zoom-out` is already the chosen codebase-understanding surface.** ADR 0013
  deliberately avoided a new `/understand` command and chose map-first
  `zoom-out` as the first workflow.
- **Impact is still orientation.** For a focused file or module, users need to
  know affected layers, dependencies, paths, and risks before making a change;
  that fits the map-first answer shape.
- **The primitives already exist.** Neighbors, paths, recall, export evidence,
  and fresh code reads are enough to validate whether impact heuristics are
  useful without expanding the Memory API prematurely.
- **RedSkills has a differentiator Graphify does not.** Structural graph edges
  can be combined with observed Reasoning attempts from AFK, so the answer can
  distinguish static dependency impact from failure/retry history.
- **Avoiding `memory_impact` keeps the API honest.** A single primitive would
  imply a stable algorithm before we have enough usage evidence.

## Rejected alternatives

- **Create a new `impact` skill now.** Rejected because it fragments the
  Codebase understanding surface before `zoom-out` proves the impact contract.
- **Add `memory_impact` immediately.** Rejected because impact analysis is a
  product heuristic, not just a graph traversal primitive. The useful shape
  should be learned from `zoom-out` answers first.
- **Put impact only under Risks/Gaps.** Rejected because impact is a primary
  question, not merely a risk footnote.
- **Lead with raw graph output.** Rejected by the existing Zoom-out answer
  contract: graph evidence supports the map; it does not replace the
  explanation.

## Consequences

- The `zoom-out` skill contract should add an optional **Impact** section when a
  focused change target is present.
- Memory graph reads remain best-effort. `zoom-out` still verifies graph claims
  against current files and degrades to ordinary code exploration when graph
  evidence is absent, stale, or unavailable.
- Future Reasoning attempts can enrich observed impact without changing the
  public surface.
- A later `memory_impact` primitive needs evidence from repeated `zoom-out`
  usage: which structural edges matter, how observed attempts should be
  weighted, and where false positives appear.
