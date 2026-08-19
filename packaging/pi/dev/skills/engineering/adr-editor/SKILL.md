---
name: adr-editor
working-mode: ADR-editing
description: Proposal-driven reverse grill for the active `.red/adr/` collection. Ranks active ADR clusters, recommends where to start, confronts one cluster with current implementation evidence, and applies maintainer-approved dispositions through the full ADR verb set. Use to review, curate, reorganise, fix, or extend ADRs and to pay down accumulated decision debt.
---

# ADR Editor — proposal-driven reverse grill

**The maintainer decides; the editor executes.** The editor supplies ranked
evidence and a recommendation, then asks the maintainer to dispose of one
proposal at a time. It completes one cluster per PR so the review remains a
coherent decision-history change.

The active collection is `.red/adr/*.md`. Retired records live under
`.red/adr/archive/`; preserve them as history, but exclude `.red/adr/archive/` from future cluster analysis. `.red/adr/INDEX.md` maps both lanes.

<what-to-do>

Run the loop: **inventory active records → rank clusters → recommend one →
confront it with current evidence → reverse-grill P01, P02, … → accumulate
accepted proposals → preview all resulting text and the exact diff → confirm
one destructive batch → apply → verify → land one cluster per PR**.

## Hard rules

- ✅ **One cluster per PR.** Do not mix another cluster into the current change.
  Finish or stop the selected cluster before recommending the next one.
- ✅ **Active records only.** Cluster and rank `.red/adr/*.md`; exclude
  `.red/adr/archive/` from future cluster analysis. Archived records may be read
  only as historical evidence for the active cluster.
- ✅ **Evidence informs; the maintainer disposes.** Deterministic helpers emit
  candidate evidence, not a disposition. The model reads the evidence, explains
  judgment, recommends an operation, and receives an explicit maintainer
  disposition for every active ADR in the cluster.
- ✅ **One proposal per turn.** Present P01, wait for `accept`, `reject`, or an
  amendment, then present P02. Never stack proposals into one question.
- ✅ **Confront decisions with reality.** Read current code, tests,
  documentation, and newer active ADRs before recommending any disposition. Do
  not infer current behavior from an ADR alone.
- ❌ **Do not change analyzed product code.** This workflow edits ADR support
  artifacts only. A product mismatch is evidence for the proposal, not authority
  to repair the product in this PR.
- ✅ **Age or lack of links is never sufficient archival evidence.** Archive
  only when the record is demonstrably auxiliary, deprecated, superseded,
  absorbed, or otherwise terminal from current evidence and maintainer judgment.
- ✅ **Absorb and merge are different.** Absorb rewrites one governing ADR to
  incorporate accepted amendments and archives only the auxiliaries. Merge mints
  a successor and archives all originals. State this tradeoff whenever both are
  plausible.
- ✅ **Review every active record in scope.** No apply step is allowed until
  every active ADR in the cluster has an explicit maintainer disposition.
- ✅ **Visible review markers.** After review, visibly annotate every reviewed INDEX bullet
  with `reviewed YYYY-MM-DD @ <short-base-sha>`, whether its ADR
  changes or stays as-is. Prioritize re-review only when new evidence exists
  after that base SHA; age alone never triggers re-review.
- ✅ **Keep `.red/adr/INDEX.md` coherent after every mutation.** The governance
  bijection `Set(active ∪ archived numbers) === Set(INDEX numbers)` must hold,
  and every archived record must carry terminal status and a successor pointer
  whenever a successor exists.
- ✅ **Honour `start/ADR-FORMAT.md`.** Sequential four-digit numbering, matching
  filename/H1, and only sections that earn their place.
- ✅ **Preserve the complete verb set.** All eleven operations remain available:
  list, group, surface inconsistencies, add, remove, rewrite, merge, split,
  archive, renumber, re-index.
- ✅ **Use the shipped deterministic core.** Triage lives in
  `apps/dev/src/core/adr-triage.ts`; mutations live in
  `apps/dev/src/core/adr-operations.ts`. Do not reimplement their parsing in
  prose or let their heuristics replace model judgment.
- ✅ **Work through normal git flow.** Branch, worktree, commit, PR; never switch
  the primary checkout's branch.
- ❌ Do not silently propagate to the wiki or Memory graph.

## Phase 0 — Build and rank the active inventory

Fetch the remote base used by the repository and record its short SHA. Build
`AdrRecord[]` from active files only, plus INDEX sections and numbers. Gather
candidate evidence for each active record from:

1. current code paths that implement or contradict it;
2. tests that bind current behavior;
3. documentation that presents the behavior to operators;
4. newer active ADRs that amend, conflict with, or supersede it.

Call `triageAdrs`, `groupAdrs`, and `detectAdrInconsistencies`, then pass the
active records, review markers, and evidence to `rankAdrClusters`. Ranking is a
stable prioritization aid: changed-since-review evidence comes first; unreviewed
clusters come next; reviewed clusters with no new evidence defer. The helper's
output is candidate evidence, not a disposition.

Show the ranked active clusters with record counts, fresh-evidence summaries,
and review-marker posture. Explicitly recommend where to start and why. If the
maintainer already named a cluster, use it and do not reopen selection. Otherwise
ask for the cluster choice once.

## Phase 1 — Confront the selected cluster

Deep-read every active ADR in the chosen cluster and the relevant current code,
tests, documentation, and newer active ADRs. Archived ADRs can explain history
but cannot join the active cluster.

Produce a private coverage ledger with one row per active ADR. Track evidence,
proposed disposition, maintainer response, and final accepted disposition. The
ledger is complete only when every row has an explicit maintainer answer.

The read-only operations remain first-class:

- **list** — `triageAdrs` entries and evidence;
- **group** — `groupAdrs` membership;
- **surface inconsistencies** — `detectAdrInconsistencies` findings.

## Phase 2 — Reverse grill, one proposal per turn

Number proposals monotonically as P01, P02, and so on. Present exactly one
proposal per turn in this shape:

```text
P01 — <short proposal title>
ADRs: <active numbers covered>
Evidence: <specific current code/tests/documentation/newer ADR findings>
Exact operation: <files, status/pointers, rewritten sections, INDEX movement>
Alternatives: <at least keep-as-is plus any credible absorb/merge/rewrite option>
Recommendation: <one choice and why>
Disposition? accept / reject / amend
```

Wait for the answer. Record `accept`, `reject`, or the maintainer's amended
operation before showing the next proposal. A rejected operation still produces
an explicit disposition such as keep-as-is; it cannot leave the ADR unresolved.

Use the operation vocabulary precisely:

- **keep** — current evidence still supports the active ADR;
- **rewrite** — update a governing ADR to match the current decision, including
  incorporating amendments into its Decision when accepted;
- **Absorb** — `planAbsorb` rewrites one governing ADR and archives only the
  auxiliaries; `applyAbsorb` applies it with rollback and INDEX coherence;
- **Merge** — `planMerge` mints a successor and archives all originals, then
  `applyComposite` applies the replacement;
- **split** — `planSplit` mints focused successors and archives the original;
- **archive/remove** — `planArchiveMove` retires an auxiliary, deprecated,
  superseded, or absorbed record via `git mv`; outright deletion requires an
  explicit maintainer request;
- **add**, **renumber**, and **re-index** retain their ordinary meanings.

## Phase 3 — Preview one accepted batch, then confirm once

As proposals are accepted, accumulate accepted proposals without mutating the
tree. After every active ADR has an explicit disposition, construct the complete
batch through the shipped planners.

Before any destructive write, show the complete resulting text and exact diff
for every affected ADR and `.red/adr/INDEX.md`. Include terminal statuses,
successor pointers, archive moves, and the visible
`reviewed YYYY-MM-DD @ <short-base-sha>` annotations.

Then ask exactly once:

> Apply this destructive batch now? (`apply` / `stop`)

This is the one confirmation for the cluster. `stop`, silence, or requested edits
cancel the plan; revise it, show the full text and diff again, and obtain a new
single confirmation. Read-only work needs no confirmation.

## Phase 4 — Apply through deterministic helpers

Immediately before apply, verify target content still matches the planned input.
Drift invalidates the preview and confirmation.

Use these public helpers:

- `planArchiveMove` / `applyArchiveMove`;
- `planStatusAndSuccessor` / `applyStatusAndSuccessor`;
- `planIndexArchive` / `applyIndexArchive`;
- `planIndexReviewAnnotation` for the visible review marker;
- `planStalePathFix` / `applyStalePathFix`;
- `planRenumber` / `applyRenumber`;
- `planIndexEntry` for add and re-index;
- `planSplit` / `applyComposite`;
- `planMerge` / `applyComposite`;
- `planAbsorb` / `applyAbsorb`.

Stop on the first failure. Preserve rollback behavior; never continue on a
half-applied tree. Update each reviewed INDEX bullet with the review date and
the short base SHA used for the evidence confrontation.

## Phase 5 — Verify and land

Rebuild the active-only inventory and re-run `triageAdrs`, `groupAdrs`,
`detectAdrInconsistencies`, and `rankAdrClusters`. Verify:

- every formerly active cluster member has its accepted disposition;
- archived auxiliaries/deprecated/superseded/absorbed records are under
  `.red/adr/archive/` and absent from active ranking;
- absorb retained and rewrote its governor; merge created one successor;
- INDEX number bijection and review annotations are coherent;
- no analyzed product code changed;
- the diff contains only this cluster's ADR support changes.

Run ADR triage, operation, editor-doc, ask-red, and router tests. Inspect the
exact diff, then land through the repository's normal flow. When the session
ends, run the shared end-of-session doc-landing finalizer in
[`/start`'s DOC-LANDING-FINALIZER.md](../start/DOC-LANDING-FINALIZER.md).

</what-to-do>

<supporting-info>

## Operation map

| Operation | Primitive |
|---|---|
| list | `triageAdrs` |
| group | `groupAdrs` |
| surface inconsistencies | `detectAdrInconsistencies` |
| cluster recommendation | `rankAdrClusters` |
| add / re-index | `planIndexEntry` |
| archive / remove | `planArchiveMove` + `applyArchiveMove` |
| rewrite metadata | `planStatusAndSuccessor` + `applyStatusAndSuccessor` |
| repair stale prose | `planStalePathFix` + `applyStalePathFix` |
| move INDEX bullet | `planIndexArchive` + `applyIndexArchive` |
| annotate INDEX review | `planIndexReviewAnnotation` |
| renumber | `planRenumber` + `applyRenumber` |
| split | `planSplit` + `applyComposite` |
| merge | `planMerge` + `applyComposite` |
| absorb | `planAbsorb` + `applyAbsorb` |

## Disposition guard

Do not substitute a heuristic for a decision. Title overlap suggests a cluster;
it does not prove merge. A stale path proves stale prose; it does not prove the
Decision is obsolete. Age and zero inbound links prove neither deprecation nor
inertness. Current implementation evidence plus maintainer judgment supplies the
disposition.

## Sibling doctors

`/red-doctor` owns process and adoption drift; `memory:doctor` owns graph health;
this skill owns the decision collection.

</supporting-info>
