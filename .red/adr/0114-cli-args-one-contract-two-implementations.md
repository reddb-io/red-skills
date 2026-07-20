# 0114 — CLI argument parsing is one contract, two implementations

- **Status**: accepted
- **Date**: 2026-07-20
- **Related**: ADR 0113 (castle owns the truth, dev owns the host boundary), ADR 0101 (red-castle is a vendored upstream substrate), ADR 0034 (`packages/shared` owns the dev CLI args layer)

## Context

#2248 / #2250 / #2252 ask where the shared CLI **argument layer** lives after the
castle crossing, and how castle's CLI "honours the rule without stranding the
upstream". The facts on the ground:

- **red-castle is vendored** from an upstream (ADR 0101) and is **decoupled** from
  `packages/shared` — it parses args with `@effect/cli` plus
  `@standard-schema/spec`, importing nothing red-skills-specific.
- **dev** parses args through `packages/shared`'s CLI args layer (ADR 0034).
- If castle imported `packages/shared`, it would **strand the upstream**: the
  vendored source could no longer sync cleanly from sandcastle, because it would
  carry a red-skills-only dependency.

So #2248's "one parsing contract" cannot mean "one shared parser both import" —
that coupling is exactly what ADR 0101 forbids.

## Decision

The shared argument layer is a **contract, not shared code**. "One parsing
contract" means **one Standard-Schema argument spec honoured by two independent
implementations**: castle via `@effect/cli`, dev via its `packages/shared`
parser, with **no code dependency between them**.

- Castle owns the truth of its own command args (ADR 0113) and stays decoupled
  from `packages/shared`, so it keeps syncing from its upstream — #2250's "without
  stranding the upstream" is honoured by construction.
- The contract is expressed through `@standard-schema/spec` (which red-castle
  already depends on) — the neutral interop standard both parsers validate
  against.
- #2252: there is **no shared-code "argument layer"**. There is a shared **schema
  contract**. Castle owns its arg schema, dev owns its host CLI, and both validate
  against the same Standard-Schema spec.

## Consequences

- Castle stays upstream-clean; the two CLIs agree on arg names and shapes through
  a schema contract, never through imported code.
- A change to the arg contract is a schema change each side re-honours, caught by
  that side's own tests — there is no shared module whose edit silently changes
  both.
- Rejected alternatives: **(b)** shared code in `packages/shared` imported by
  castle — strands the upstream; **(c)** castle owns the parser and dev imports it
  — couples dev to castle's upstream churn.
- This is a direct application surface for ADR 0113's "castle owns the truth"
  seam to the CLI: the arg *truth* is each owner's schema; the parser is each
  owner's mechanism.
