---
name: review-adrs
description: Triages the `.red/adr/` set, previews and explicitly gates reversible mechanical cleanup, and interviews judgment findings into one actionable Spec. Use when asked to review or curate ADRs, after adding or reversing an ADR, or when ADR decision debt needs reconciliation.
---

# Review ADRs (read-only triage → gated cleanup → actionable Spec)

**Read-only is the default — classify every ADR, present the buckets, and write only the exact mechanical operations the maintainer explicitly confirms. Route judgment through an interview into one Spec.**

<what-to-do>

## 1. Detect from the committed decision record (always read-only)

**Fetch the source of truth** — run `git fetch origin`, resolve `origin/HEAD` to the remote default branch, and set the lint ref to `origin/<default-branch>`. Discover ADR/context files with `git ls-tree -r --name-only "$lint_ref" -- .red/adr .red/CONTEXT-MAP.md .red/contexts` and read them with `git show "$lint_ref:$path"`; do **not** inspect `.red/adr/` from the working tree. Use local `HEAD` only when no `origin` remote/ref exists, and state that fallback before the report.

**Preserve the record** — treat each ADR as immutable-hybrid: the Decision stays byte-for-byte unchanged; only status, `Related`/`superseded-by` links, INDEX placement, and stale-path prose may be mechanical. A changed decision, merge, or split mints successor ADRs through the judgment route.

## 2. Run triage and present the buckets

**Surface the optional subject filter** — accept no filter for the full set, or map the requested scope to the `AdrSubjectFilter` variants in `apps/dev/src/core/adr-triage.ts`: `numbers` for ADR numbers, `text` for subject text, and `index-section` for an INDEX heading. Examples: `/review-adrs`, `/review-adrs --subject "AFK heartbeat"`, `/review-adrs --subject-numbers 0042,0112`, and `/review-adrs --subject-section "Memory"`.

**Call `triageAdrs`** — build its context from every ADR plus the same-ref path inventory and INDEX sections, then pass the optional subject. Classification still uses the whole ADR tree; the subject filter scopes only which entries and counts the report presents, so cross-record supersession and inbound-link signals survive a narrow run.

**Present the triage report once** — show the matched subject (and unmatched requested numbers), counts, then ADR number/title/reason grouped into `archive-candidate`, `missing-supersession`, `stale-reference`, `merge-candidate`, `split-candidate`, and `keep`. Alongside the buckets, retain the read-only checks for numbering collisions, contradictions, and structural or controversial decisions. Deep-review flagged findings only.

## 3. Preview the mechanical plan (still read-only)

**Partition by reversibility** — a fully determined archive move, terminal status/successor edit, INDEX archive resync, or stale-path prose repair is mechanical. Any unknown successor, uncertain replacement, live-decision supersession, merge, split, numbering choice, incoherence, or wiki/Memory propagation is judgment and goes to step 5.

**Plan before asking** — use only the pure planners from `apps/dev/src/core/adr-operations.ts`: `planArchiveMove`, `planStatusAndSuccessor`, `planIndexArchive`, and `planStalePathFix`. An archive plan already composes status + `git mv` + INDEX resync, so represent that as one operation. Keep every planner free of filesystem writes.

**Show the exact plan** — number each operation and show affected paths, successor/status or stale-path replacement, the planned diff, and recovery shape. Confirm every target still matches the lint-ref bytes and has no overlapping uncommitted edit; when it drifted, re-detect and re-plan from the new truth before offering apply.

## 4. Explicit confirmation gate

**Ask one bounded question** — after the preview, ask: `Apply mechanical operations [IDs] in-session now? (yes/no or list the IDs to apply)`. Accept only an unambiguous yes for the displayed set or explicit operation IDs. Anything except an explicit confirmation keeps the run read-only. No confirmation means no write; never infer approval from invoking `/review-adrs`, choosing a subject, or approving a judgment decision.

**Apply only the confirmed IDs** — apply the confirmed mechanical operations in-session with the matching IO helpers: `applyArchiveMove`, `applyStatusAndSuccessor`, `applyIndexArchive`, and `applyStalePathFix`. Use `applyArchiveMove` once for its composed status/move/INDEX change rather than repeating its component helpers.

**Verify from fresh state** — inspect the resulting diff, confirm each Decision is unchanged, run `git diff --check` and the ADR governance test, then report applied IDs and remaining findings. On helper failure, keep its built-in rollback result visible and stop further applies until the maintainer chooses how to proceed.

## 5. Judgment route: interview → Spec → `/afk`

**Reconcile one finding per turn** — ask one zero-padded `Q##` with finite branches, a recommended branch plus reason, and a defer option; wait for the reply before re-evaluating cascades and asking the next question. Record each agreement without applying it.

**Publish judgment work through `/to-spec`** — include the debt and plan, one User Story per agreed action, and every `Q##` answer as a Human Decision with Why and Alternatives. Publish as `type:spec` + `needs-slicing`; `/to-tickets` then slices it and `/afk` executes it. If there are no agreed judgment actions, finish without creating an empty Spec.

**Propagate deliberately** — for ADRs changed or proposed for change, use `/wiki lint` and Memory provenance reads to find derived claims; make each re-ingest or `memory_supersede` choice its own judgment question and Spec item.

**Finish the session** — run the shared end-of-session doc-landing finalizer in [`/start`'s DOC-LANDING-FINALIZER.md](../start/DOC-LANDING-FINALIZER.md) before exiting.

</what-to-do>

<supporting-info>

## Operation boundary

| Finding | Before confirmation | After explicit confirmation |
|---|---|---|
| Terminal ADR with known successor | Preview status + archive move + INDEX resync | Apply the composed archive plan in-session |
| Known stale path outside Decision | Preview replacement plus provenance note | Apply only that prose repair in-session |
| Merge, split, live-decision change, ambiguity | Interview one decision at a time | Publish the agreement to a Spec; no direct apply |

The confirmation gate controls mechanical writes only. The interview controls judgment, not permission to mutate; read-only detection and triage never write.

</supporting-info>
