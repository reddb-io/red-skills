# Multi-context plugin glossaries

Status: accepted
Supersedes: [ADR 0005](0005-single-global-red-dir.md)

## Context

ADR 0005 deliberately kept one root `.red/CONTEXT.md` while `memory` was being
absorbed into the RedSkills marketplace. That kept the initial merge simple, but
the glossary has since become a coupling point between two product contexts:
`dev` owns engineering workflow language, while `memory` owns persistent memory,
graph schema, reasoning evidence, and RedDB-backed codebase mapping language.

The `dev:start` context format already supports multi-context repos through a
root `.red/CONTEXT-MAP.md`. The user chose that branch after the glossary began
mixing plugin-specific language.

## Decision

Use a multi-context glossary layout:

- `.red/CONTEXT-MAP.md` is the entry point.
- `.red/contexts/dev/CONTEXT.md` owns `dev` plugin and engineering workflow
  terms.
- `.red/contexts/memory/CONTEXT.md` owns `memory` plugin, RedDB graph, reasoning
  memory, validation evidence, skill telemetry evidence, and codebase mapping
  terms.
- `.red/CONTEXT.md` remains only as a compatibility pointer to the map.
- ADRs stay in the single root `.red/adr/` sequence for now; future
  context-specific ADR subtrees require a separate decision.

## Why

- The plugins now have clear product boundaries.
- Keeping every term in one glossary makes cross-plugin integration look like
  one domain instead of a relationship between two domains.
- A context map preserves the shared repo entry point while making agents choose
  the right language surface before editing documentation.
- Keeping ADRs global avoids number churn while still allowing the glossary to
  split immediately.

## Rejected alternatives

- Keep a single glossary with internal headings. This preserves old simplicity
  but keeps unrelated plugin terms in one file and does not exercise the
  existing multi-context model.
- Create per-plugin `.red/adr/` subtrees now. That is more complete isolation,
  but the current pain is glossary coupling, not ADR numbering or ownership.
- Delete root `.red/CONTEXT.md`. That is cleaner, but existing tools and agent
  habits may still open that file directly.

## Consequences

- New terms must be added to the owning context, not the compatibility pointer.
- Cross-plugin relationships belong in `.red/CONTEXT-MAP.md`.
- ADR 0005 remains useful history but is no longer the active context-layout
  decision.
