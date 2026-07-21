---
name: review-adrs
description: Review the `.red/adr/` set with read-only lifecycle triage, optionally scoped by subject; apply explicitly confirmed mechanical maintenance in-session, then reconcile judgment findings through an interview and `/to-spec`. Use when asked to "review the ADRs", after adding or reversing an ADR, or to curate accumulated decision debt.
---

# Review ADRs (read-only triage → gated maintenance → judgment Spec)

**Triage the decision record read-only first. Apply only reversible mechanical
maintenance after one explicit confirmation; route every judgment operation
through a one-question-at-a-time interview and one actionable Spec.**

ADRs accumulate and derive: one supersedes another, paths move, shipped decisions
become inert, and records overlap or grow too broad. This skill is the doctor of
decisions — sibling to `/red-doctor` (adoption) and `memory:doctor` (graph). It has
one door but two resolution lanes:

- mechanical maintenance: archive move, terminal status/successor, INDEX archive
  resync, and stale-path prose repair; reversible helpers may apply in-session;
- judgment: merge, split, supersede a live decision, or reconcile controversy;
  interview first, then `/to-spec` → `/to-tickets` → `/afk`.

<what-to-do>

Run these phases in order: **scope → fetched read-only detection → triage buckets →
mechanical plan → explicit confirmation gate → optional apply → judgment
interview/Spec**. Detection and planning never authorize a write.

## Hard rules

- ✅ **Read-only is the default. No confirmation means no writes.** An omitted,
  declined, ambiguous, or interrupted gate ends the mechanical lane after showing
  the plan. Do not interpret a request to review, a subject choice, or an interview
  answer as apply consent.
- ✅ Preserve ADR history. Never rewrite `## Decision`. Mechanical edits are limited
  to status/successor metadata, `Related` links when supported by the helper plan,
  stale-path prose outside `## Decision`, `.red/adr/INDEX.md`, and `git mv` into
  `.red/adr/archive/`.
- ❌ **Merge and split remain judgment operations.** So do renumbering, changing a
  live decision, choosing among plausible successors/replacement paths, and
  resolving contradictions. Never apply these through the mechanical gate.
- ❌ **Judgment operations are never applied in-session.** They only ever become
  Spec work items, executed later by `/to-tickets` + `/afk`. No confirmation, no
  interview answer, and no maintainer instruction inside this skill authorizes
  minting, rewriting, or archiving an ADR for a merge, split, or supersede.
- ✅ Every judgment proposal is **supersede-and-replace** — mint the successor
  ADR(s) and archive the original(s) with `superseded-by` pointers, **never
  in-place rewrites** of a historical record (ADR 0112).
- ❌ Do not silently propagate to the wiki or Memory graph. Their changes remain
  separate interview decisions and Spec items.
- ❌ Do not stack judgment questions. Ask one `Q##` per turn, wait, then re-evaluate.
- ✅ Before detection, run `git fetch origin`, resolve `origin/HEAD` to the remote
  default branch, and lint from `origin/<default-branch>`. Discover and read with
  `git ls-tree` / `git show`; do **not** inspect `.red/adr/` from the working tree.
  Use local `HEAD` only when no `origin` remote/ref exists, and state that fallback.
- ✅ Compose the shipped classifier and operation helpers. Do not reimplement their
  parsing, bucketing, archive layout, compensation, or Decision-section guard.
- ✅ Honour `start/ADR-FORMAT.md` and finish through the shared doc-landing finalizer.

## Phase 0 — Surface the optional subject filter

At the start, state the scope: **all ADRs** by default, or the optional subject
filter supplied by the user. Accept exactly the classifier's three subject forms:

- ADR numbers (`{ kind: "numbers", numbers: [...] }`);
- text appearing in ADR title/path/status/body (`{ kind: "text", query: "..." }`);
- an INDEX theme (`{ kind: "index-section", section: "..." }`).

If the user did not supply a filter, mention these choices without blocking and
continue over all ADRs. A filter narrows what is reported and proposed, never the
cross-record evidence used to classify it. Show matched numbers and any unmatched
requested numbers in the triage report.

## Phase 1 — Detect and triage read-only

Fetch first. Resolve the lint ref and read every `.red/adr/**/*.md`,
`.red/adr/INDEX.md`, `.red/CONTEXT-MAP.md`, and relevant `.red/contexts/**` from
that ref. Path inventories and existence checks must query the same ref. Derive
the `AdrRecord[]`, existing-path inventory, INDEX sections, and age facts, then
call `triageAdrs` from `apps/dev/src/core/adr-triage.ts`, passing the optional
subject filter. Classification must see the whole ADR set even when output is
subject-scoped.

Present counts and entries for all six buckets, including each entry's reason and
useful signals:

- `keep` — live guidance with no detected lifecycle debt;
- `stale-reference` — path prose may have a mechanical repair;
- `missing-supersession` — terminal metadata may be incomplete;
- `merge-candidate` — judgment lane;
- `split-candidate` — judgment lane;
- `archive-candidate` — terminal/inert record may be mechanically archived.

Deep-read flagged records from the lint ref. Also detect numbering collisions,
contradictions, unresolved controversial decisions, and unimplemented decisions;
add those directly to the judgment ledger rather than forcing them into a
mechanical bucket. Compose `/wiki lint` and Memory provenance/contradiction reads
when those plugins are available; these reads do not authorize propagation.

## Phase 2 — Build the mechanical plan, still read-only

Only plan an operation when every input is evidenced and unambiguous. Use the
pure planners in `apps/dev/src/core/adr-operations.ts` and show the exact ADRs,
source/destination paths, status/successor values, stale/replacement paths, INDEX
edits, and helper names before asking for confirmation:

- terminal archive: `planArchiveMove` (status + `git mv` + INDEX archive resync);
- status only: `planStatusAndSuccessor`;
- standalone INDEX archive resync: `planIndexArchive`;
- stale-path prose outside `## Decision`: `planStalePathFix`.

Do not plan the standalone status or INDEX operation when `planArchiveMove`
already owns that edit. If a successor, replacement path, archive eligibility,
or historical meaning is uncertain, move the finding to the judgment ledger.
Keep planner errors read-only and report them; never fall back to hand editing.

If the plan is empty, skip the apply gate and continue to the judgment lane (or
finish with the read-only report when there are no judgment findings).

## Phase 3 — Explicit confirmation gate

After displaying one complete mechanical plan, ask exactly one **Explicit
confirmation gate**:

> Apply all N listed mechanical operations in-session now? (`apply all` / `keep read-only`)

Only an unambiguous `apply all` given after the plan authorizes those exact
operations. `keep read-only`, no reply, a conditional reply, or any requested
change means no writes. A requested subset or changed input invalidates the plan:
re-plan, display the replacement in full, and ask a fresh gate. Confirmation
never covers judgment-ledger items, wiki/Memory propagation, commits, or landing.

## Phase 4 — Apply confirmed mechanics with shipped helpers

Immediately before writing, verify that every target's working-tree content still
matches the content used to produce the confirmed plan and that destinations do
not conflict. Drift cancels confirmation: report it, re-detect, and re-plan.

Apply only through the corresponding exported helpers:

- `applyArchiveMove` for a `planArchiveMove` result;
- `applyStatusAndSuccessor` for a `planStatusAndSuccessor` result;
- `applyIndexArchive` for a `planIndexArchive` result;
- `applyStalePathFix` for a `planStalePathFix` result.

The helpers' injected filesystem and git adapters must perform real writes and
`git mv`; preserve their compensation behavior on failure. Never continue with
later operations after an apply failure. After success, inspect the exact diff,
assert no `## Decision` content changed, and run the ADR governance and operation
tests. Re-run `triageAdrs` against the resulting tree to show the post-apply
buckets. Do not commit or publish here; the doc-landing finalizer owns landing.

## Phase 5 — Reconcile judgment findings (`/start` style)

### Judgment operation vocabulary

Three operations carry real consequence for the record: **merge** mints one
consolidating ADR and archives the N originals, **split** mints N focused ADRs and
archives the original, and **supersede a live decision** mints the successor and
archives the original. Each is proposed in the interview and, once agreed, recorded
as a Spec work item in exactly this shape:

| Operation | Trigger | Proposed work item (supersede-and-replace) |
|---|---|---|
| **merge** | `merge-candidate` — N records cover one decision | mint **one consolidating ADR** carrying the current decision, then archive **the N originals**, each `superseded-by` the new number |
| **split** | `split-candidate` — one record carries many decisions | mint **N focused ADRs**, then archive the original `superseded-by` the list of new numbers |
| **supersede a live decision** | the decision changed, contradicts another record, or "this decision is incoherent" | mint **the successor ADR** stating the new decision, then archive the original `superseded-by` the successor |

Every shape mints new numbers and archives originals — the number set grows, which
is the honest cost of an immutable record. Never propose editing `## Decision`,
renumbering in place, or deleting a record; those are **never in-place rewrites**
and no variant of them is offered as a branch.

State in each proposal which ADRs are minted (as `ADR-NEW-1`, `ADR-NEW-2`, … until
`/to-tickets` allocates real numbers) and which are archived with which pointer.

### The interview loop

Walk the judgment ledger highest-impact first: numbering collision → contradiction
→ merge/split → supersede a live decision → ambiguous supersession/path/archive →
structural or controversial decision. For each unresolved finding, ask one question:

> **Q##:** [decision to reconcile]
> **Branches:**
>  (a) [resolution A]
>  (b) [resolution B]
>  (c) defer — leave open, no Spec item
> **Recommend:** (a), because [one-sentence reason].
> *(answer, redirect, or push back — I'll wait)*

Number questions `Q01`, `Q02`, … per invocation. Record the agreed action without
applying it. Re-evaluate cascades before the next question. When relevant, ask
separately whether to refresh thematic INDEX clustering, re-ingest affected wiki
claims, or supersede obsolete Memory claims; each accepted action remains a Spec
item, never an inline mutation.

## Phase 6 — Emit one Spec for judgment work

If the ledger contains agreed judgment or propagation work, hand it to `/to-spec`:

- Problem/Solution: the decision debt and reconciliation plan;
- User Stories: one story per agreed judgment operation — the ADRs to mint and the
  originals to archive with their `superseded-by` pointers — plus ambiguous
  metadata, INDEX clustering, wiki, Memory, or implementation work;
- Human Decisions: every `Q##` answer in Decision/Why/Alternatives shape. Each
  agreed merge, split, and supersede-a-live-decision lands here as its own Human
  Decision, so the reason the record changes shape survives the handoff.

The Spec is the only artifact this skill produces for judgment work; `/to-tickets`
slices it and `/afk` executes it later. Emitting the Spec is not permission to
start it.

Publish with `type:spec` + `needs-slicing` (never `ready-for-agent`; `/to-spec`
handles labels). Do not publish an empty Spec for a mechanical-only or read-only
run. End with the scoped bucket receipt, mechanics applied or kept read-only,
deferred judgment, and the Spec link when one exists.

### End-of-session doc-landing finalizer

When the ADR review session ends, run the shared end-of-session doc-landing finalizer
in [`/start`'s DOC-LANDING-FINALIZER.md](../start/DOC-LANDING-FINALIZER.md)
before exiting. It remains silent when no docs changed.

</what-to-do>

<supporting-info>

## Composition map

| Phase | Reuses |
|---|---|
| Scope + triage | `triageAdrs` and its subject filter/report |
| Mechanical plan/apply | `adr-operations.ts` planners + compensated apply helpers |
| Judgment interview | `/start` one-question discipline |
| Propagation reads | `/wiki lint` + Memory provenance/contradiction reads |
| Judgment publication | `/to-spec` → `/to-tickets` → `/afk` |
| Doc landing | shared `DOC-LANDING-FINALIZER.md` |

## Boundary examples

- A superseded ADR with an unambiguous successor can be statused and archived in
  the confirmed mechanical batch. Deciding whether supersession is full or partial
  is judgment and goes through `Q##`.
- A backticked path with a verified rename can use the stale-path helper. Choosing
  between plausible replacement paths is judgment.
- Merge/split always mint replacement ADRs and archive originals later; they never
  rewrite historical Decisions in-session.
- "This ADR is wrong now" is a supersede-a-live-decision proposal, not a status
  edit: the live record stays live until the Spec's successor ADR lands.
- Agreeing to a merge in the interview produces a Spec work item. Doing the `git mv`
  in the same session is the failure this lane exists to prevent.
- A run stopped before or at the gate is a successful read-only review, not a
  partially failed apply.

</supporting-info>
