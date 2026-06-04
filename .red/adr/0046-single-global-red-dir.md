# A single global `.red/` shared by all plugins

## Status: superseded by ADR 0021

Related: [ADR 0021](0021-multi-context-plugin-glossaries.md)

red-skills is a plugin marketplace: today one plugin (`dev`), soon a second
(`memory`, absorbed from red-memory). The absorbed project arrived with its own
domain documentation — `SPEC.md`, `.red/prd/`, and `.red/adr/` (including a
license ADR) — scoped to that single project. red-skills' own domain-doc system
already anticipates multi-context repos via a `.red/CONTEXT-MAP.md` plus
per-context `.red/adr/` subtrees. So when a second plugin lands, there is a fork:
give each plugin its own `.red/`, or keep one.

## Decision

Keep **one global `.red/` at the repo root**, shared by every plugin: a single
`CONTEXT.md` glossary and a single, continuously-numbered `.red/adr/` set. Do
**not** introduce `.red/CONTEXT-MAP.md` or per-plugin `.red/` subtrees.

red-memory's design docs are not migrated as parallel doc trees: `SPEC.md` and
its PRD become tracker issues (PRD #49 and its slices) and the source files are
deleted; its license ADR folds into [ADR 0004](0004-relicense-apache-2-0.md).

## Why

- **Both plugins must share the same structure.** The `dev` plugin has no
  per-plugin `.red/`; the repo has one root `.red/`. Mirroring that for `memory`
  means no per-plugin `.red/` either — a single root one.
- **One source of vocabulary and decisions.** `memory` lives on top of `dev` and
  improves its processes; they share concepts (issues, slices, recall, the graph
  taxonomy). Splitting the glossary would let the same term drift between
  contexts.
- **Avoids ADR-number collisions** that a merge of two independently-numbered
  `.red/adr/` sets would create — there is one monotonic sequence.

## Rejected alternatives

- **Multi-context** (`.red/CONTEXT-MAP.md` + `plugins/memory/.red/`). Cleaner
  domain isolation, but breaks the "same structure as `dev`" rule the project
  imposed and fragments the single process the repo is converging on.
- **Discard red-memory's process docs entirely.** Loses design rationale worth
  preserving; instead the rationale is re-expressed as tracker issues + ADRs.

## Consequences

- All plugins read and write the one root `.red/CONTEXT.md` and `.red/adr/`.
- Memory-domain terms (node/edge taxonomy, recall, the `memory` plugin and its
  hard dependency on `dev`) are added to the existing glossary, not a new one.
- If the repo ever genuinely needs context isolation, revisiting this means
  introducing `CONTEXT-MAP.md` and splitting — a deliberate later decision.
