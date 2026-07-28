# 0127 — The ADR editor is totipotent: the maintainer decides, the skill executes

## Status

Accepted. Supersedes ADR 0112, whose gated/immutable-curation model this record
replaces.

## Context

ADR 0112 made the ADR skill a read-only detector with a narrow gated apply lane:
mechanical maintenance (archive `git mv`, terminal status, INDEX resync,
stale-path prose) could be applied in-session behind one confirmation, while
every judgment operation — merge, split, supersede a live decision, resolve a
contradiction — was banned from the session and could only become a Spec routed
through `/to-spec` → `/to-tickets` → `/afk`. Rewriting a `## Decision` was
forbidden outright; supersede-and-replace was the only permitted shape.

In practice that model made the one skill that owns the decision collection the
least able to change it. Asking to merge two overlapping ADRs produced a Spec
instead of a merge. Asking to renumber a collided pair produced a Spec. The
maintainer, who owns the record and is present in the session, had to route
their own decision through three skills and an autonomous lane to see it land.
The ADR collection is repository documentation the maintainer authors; the
protections that made sense for an autonomous agent editing history unattended
became friction for the human who owns it.

Two capabilities the collection genuinely needs also had no home under 0112:
grouping the records by subject, and reporting where the collection contradicts
itself (dangling supersede pointers, supersession cycles, numbering collisions,
INDEX drift). Both are read-only, both were absent, and neither could be added
without widening the skill's charter.

## Decision

- **The ADR editor is totipotent.** `/adr-editor` — the renamed successor to the
  ADR 0112 skill — supports every operation over `.red/adr/` as an in-session verb:
  list, group by subject, surface inconsistencies, add, remove, rewrite, merge,
  split, archive, renumber, re-index. The maintainer decides; the skill
  executes.
- **No read-only default and no Spec gate.** Detection no longer precludes
  mutation, judgment operations are no longer deferred, and `/to-spec` becomes an
  *offered* escape hatch for genuinely large batches — never a required route.
- **In-place rewriting is permitted, including `## Decision`.** ADR 0112's
  immutability rule is lifted. Supersede-and-replace remains the shape that
  preserves the most history, so the skill names it as the alternative and lets
  the maintainer choose; it is a recommendation, not a constraint.
- **Four safeties remain, and only these four.** (1) One confirmation before a
  destructive or wide batch mutation — destructive means removing or rewriting
  decision content, wide means more than three records. (2) `.red/adr/INDEX.md`
  stays coherent after every mutation. (3) `start/ADR-FORMAT.md` is honoured.
  (4) Work lands through the repo's normal branch/worktree/PR flow.
- **The archive stays physical and append-only.** ADR 0112's archive mechanics
  survive their parent decision: a terminal record is `git mv`'d to
  `.red/adr/archive/` with a terminal status and a `superseded-by:` pointer, the
  lane is append-only, and the governance bijection
  `Set(active ∪ archived numbers) === Set(INDEX numbers)` still holds. What is
  lifted is the *policy* on who may change a record, not the *machine-enforced
  guard* on losing one.
- **Capabilities live in the core, not in prose.** Grouping and inconsistency
  detection ship as `groupAdrs` and `detectAdrInconsistencies` in
  `apps/dev/src/core/adr-triage.ts`; renumber, re-index, split, and merge ship as
  `planRenumber`, `planIndexEntry`, `planSplit`, and `planMerge` in
  `apps/dev/src/core/adr-operations.ts`. A new capability extends those modules —
  the SKILL.md never re-derives their parsing.

## Considered options

- **Keep ADR 0112 and widen only the mechanical lane**: rejected — the friction
  was never in which operations counted as mechanical, it was in the deferral
  itself. Reclassifying merge as mechanical would keep the taxonomy while losing
  the reason it existed.
- **Keep the immutability rule but drop the Spec routing**: rejected — "you may
  merge in-session but never edit a Decision" still forces number growth for
  every correction, including fixing a typo in a decision the maintainer wrote
  ten minutes earlier.
- **Split into two skills, a read-only reviewer and a writer**: rejected — the
  collection deserves one door. Two doors reintroduce the routing question this
  ADR removes, one level up.
- **Drop the destructive-batch confirmation too**: rejected — a single
  confirmation before a wide or destructive batch is cheap, and it is the only
  thing standing between a misread instruction and a rewritten decision history.

## Consequences

- ADR 0112 is archived as `superseded-by: 0127`; its archive mechanics and
  governance guards are restated here and remain in force.
- The ADR 0112 skill name no longer exists. `/adr-editor` replaces it outright,
  with no alias, stub, or deprecation shim.
- ADR numbers grow more slowly, because a correction can now be a correction.
  Records therefore carry more of their own edit history in prose — say in the
  record when a decision changed and why.
- The governance test (`adr-governance.test.ts`) is unchanged and remains the
  machine-enforced floor: history can still not be destroyed by a careless
  operation, whoever authorised it.
