# `dev` owns the mutating Skill curator

## Status

accepted.

ADR 0014 keeps the **Skill curator** inside the **Memory plugin** as evidence
and report-only recommendations, and states that any mutation of **Curatable
skills** "remains a separate workflow outside the Memory plugin." This ADR
decides where that separate workflow lives and how it is allowed to act. It is
prompted by absorbing the maintenance logic of Hermes' `agent/curator.py`, which
combines telemetry, review, and file mutation in one runtime.

## Decision

The mutating Skill curator is a **`dev` plugin skill** (`/curate`). It consumes
the Memory plugin's report-only output (`memory curate skills --json`) and
performs the file action; it never reads RedDB or graph internals directly,
preserving the one-directional `dev` → Memory soft-use boundary (ADR 0009) and
the report-only Memory curator (ADR 0014).

Constraints on the mutation:

- **Archive-only, never delete.** The only mutation is a recoverable archive of
  a **Curatable skill**. Deletion is out of scope (Hermes itself refuses to
  auto-delete). Pinned and bundled (`source_kind` `plugin`/`hub`) skills are
  never archived.
- **Never silent — consent in two phases.**
  - *Phase 1 — interactive:* `/curate` is invoked by the user, lists candidates,
    and asks before archiving.
  - *Phase 2 — background:* a background trigger may only **detect** candidates
    and file a `ready-for-human` **Issue**; the archive runs after explicit human
    approval (a later `/curate` or `/afk`), never as silent background mutation.
- **Deterministic decisions.** Archive / stale / abandoned candidates come from
  thresholds over Memory's rollups. An LLM review pass is reserved for a future
  **consolidation** slice (semantic redundancy a threshold cannot detect), not
  for archive.
- **Downstream-targeted.** The curator acts on Curatable skills in the user's
  own working projects, where local / agent-created skills accumulate. RedSkills
  ships only bundled skills, so curating the RedSkills catalogue itself is a
  product decision via `/triage` + PR, not auto-archive — and `--skill-telemetry`
  stays off in the RedSkills repo.

## Why

- **Boundaries stay clean.** Memory remains the only RedDB-aware plugin and stays
  report-only (ADR 0014); `dev` already orchestrates state-driven actions (`/afk`,
  `/triage`), so a mutating curator is the same shape as an existing `dev` skill.
- **Mutation is the scary part.** Archive-only + explicit consent keeps the one
  invariant we are relaxing ("a curator may now touch skill files") bounded and
  recoverable; Hermes leans on "archive is recoverable" as its safety net too.
- **The metric is enough for archive.** Inactivity and failure rates are
  deterministic; only consolidation is genuinely semantic, so the LLM cost is
  deferred to where it actually adds signal.
- **Hermes provides the shape, not the boundary.** Hermes fuses review counters
  and file mutation in one orchestrator; RedSkills keeps telemetry (Memory),
  recommendation (Memory, report-only), and mutation (`dev`, consented) as
  distinct surfaces.

## Consequences

- A new `dev` skill (`/curate`) is needed; it shells out to `memory curate skills
  --json` and owns the archive mechanics and the consent UX.
- The background path depends on the Issue tracker and `ready-for-human` flow that
  `/afk` already uses; no new background-mutation primitive is introduced.
- Consolidation (LLM-reviewed) and the autonomous inactivity trigger are explicit
  future slices, each cheap to add on top of this boundary without revisiting it.
- "A Skill curator does not mutate skills itself" remains true **for the Memory
  plugin**; the mutation now has a named home in `dev` rather than being an
  unowned "separate workflow."

## Status

Accepted; post-0041 supersession applies **on migration**. The surviving
decision is that the mutating curator remains a `dev` workflow and never reads
Memory's RedDB/graph internals directly. What is obsoleted on migration is the
assumption that `/curate` consumes Memory's report-only output through an
in-repo `memory curate skills --json` CLI. After ADR 0041 lands, `dev` should
consume that report through the `red-memory` MCP contract. The implementation
rewiring is intentionally outside this record.

## Related

- ADR 0041 — red-skills consumes the `red-memory` and `red-ui` MCPs instead of
  building the memory plugin in this repo.
