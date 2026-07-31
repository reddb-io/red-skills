---
name: adr-editor
description: Totipotent editor for the `.red/adr/` decision collection — opens by asking which subject to work on, offering the collection's real INDEX themes and subject clusters, then lists, groups, surfaces inconsistencies, adds, removes, rewrites, merges, splits, archives, renumbers, and re-indexes, all applied in-session. Use when asked to review, curate, reorganise, fix, or extend the ADRs, after adding or reversing a decision, or to pay down accumulated decision debt.
---

# ADR Editor (interview-first, totipotent, one confirmation for destructive batches)

**The maintainer decides; the editor executes.** Every ADR operation is available
in this session — there is no read-only default, no judgment lane held back for
later, and no Spec routing to pass through first.

**Open by asking where it hurts.** A collection-wide sweep nobody asked for buries
the one record the maintainer came for, so the run starts with a question and the
question arrives with answers already in it.

The `.red/adr/` collection is the repository's decision memory: `.red/adr/*.md`
holds live guidance, `.red/adr/archive/*.md` holds retired records, and
`.red/adr/INDEX.md` is the map over both. This skill is one of the few entry
doors to that collection, so it carries the whole verb set rather than a subset.

<what-to-do>

Run the loop: **interview for the subject → read that slice → report (list,
groups, inconsistencies) → agree the operations → confirm once if the batch is
destructive or wide → apply in-session → verify → land**.

## Hard rules

- ✅ **Ask first, sweep second.** Every run opens with the subject question; the
  buckets, groups, and inconsistencies come after the answer. A report the
  maintainer did not scope is noise they have to re-read the collection to use.
- ✅ **Ask with the collection's own subjects in hand.** `groupAdrs` names the
  INDEX themes and the title-term clusters that actually exist — offer those with
  counts. A bare "which subject?" hands the work straight back to the maintainer,
  which is the failure this skill exists to avoid.
- ✅ **Execute what the maintainer asks, in this session.** Every one of the
  eleven operations — list, group, surface inconsistencies, add, remove,
  rewrite, merge, split, archive, renumber, re-index — is applied here, not
  deferred, not converted into a proposal.
- ✅ **Confirm once before a destructive or wide batch mutation.** Destructive
  means it removes or rewrites existing decision content: remove, rewrite a
  `## Decision`, merge, split, renumber, or archive. Wide means it touches more
  than three records at once. Ask one question, get one answer, then apply the
  whole agreed batch — never re-ask per record.
- ✅ **Leave `.red/adr/INDEX.md` coherent after every mutation.** The governance
  bijection `Set(active ∪ archived numbers) === Set(INDEX numbers)` must hold
  when the session ends, and every archived record must carry a terminal status.
  A `superseded-by:` pointer is required only when a successor exists — a record
  archived for going inert has none, so do not invent one to satisfy the rule.
- ✅ **Read supersession by direction.** `missing-supersession` means *this*
  record is superseded and says so badly; a status that names a record this one
  supersedes is the healthy forward end and is never debt. A successor pointer
  that names an issue or PR (`Superseded by: #2417`) stays flagged — a decision
  is superseded only by another decision — so cure it by naming the successor
  ADR, never by writing a fabricated pointer into a live record.
- ✅ **Honour `start/ADR-FORMAT.md`.** Sequential four-digit numbering, an H1 that
  reads `# NNNN — Title` and matches its filename, and sections only where they
  earn their place.
- ✅ **Compose the shipped core.** Detection, bucketing, grouping, archive layout,
  and every mutation planner live in `apps/dev/src/core/adr-triage.ts` and
  `apps/dev/src/core/adr-operations.ts`. Extend those modules when a capability
  lacks a primitive — never re-derive their parsing in prose here.
- ✅ **Work through the repo's normal git flow.** Branch, worktree, commit, PR —
  the same discipline as any other change. The primary checkout never switches
  branch.
- ✅ Read the collection from the fetched remote default branch when the question
  is "what has actually landed": `git fetch origin`, resolve `origin/HEAD`, and
  read with `git ls-tree` / `git show` from `origin/<default-branch>`. Fall back
  to local `HEAD` when no `origin` ref exists, and say so. Mutations always apply
  to the working tree.
- ✅ Ask **one question per turn, each narrowing the last** — the subject first,
  then only what stays genuinely ambiguous: the correct successor, the right
  split boundary, which of two records survives a merge. Wait for each answer;
  stacked questions turn an interview into an interrogation.
- ❌ Do not silently propagate to the wiki or the Memory graph — propagation is
  its own request, so offer it and act only when asked.

## Phase 0 — Interview for the subject (before any deep read)

**Derive the choices, then ask once.** Two moves, in that order:

1. **Derive** — build `AdrRecord[]`, the existing-path inventory,
   `indexSections`, `indexNumbers`, and age facts, then call `groupAdrs` with no
   subject filter. It returns `index-section` groups for records an INDEX theme
   already claims and `subject-cluster` groups for the rest, clustered by shared
   title terms, plus the `ungrouped` singletons. This cheap whole-tree
   derivation is the only collection-wide read this phase earns — no deep read
   of any record yet.
2. **Ask** — one question that carries its own answers: take the group titles and
   **offer them as numbered choices with their record counts**.

> **Which subject should I work on?** 1. Execution and AFK (14) · 2. Memory
> graph (9) · … · 8. ungrouped singletons (6) · 9. everything (131 records)

**Skip the question when the invocation already names the subject** — "merge
0034 and 0060", "the ADRs about rsp", "the Execution INDEX theme" all fix the
slice. Echo the resolved filter in one line and go straight to Phase 1.

**Classify the answer into exactly one of the three subject forms** the
classifier accepts:

- ADR numbers — `{ kind: "numbers", numbers: [...] }`;
- text in title/path/status/body — `{ kind: "text", query: "..." }`;
- an INDEX theme — `{ kind: "index-section", section: "..." }`.

**Keep "everything" reachable as the last choice — never a silent default.** The
maintainer picking it runs the whole collection with no filter; nobody picking it
means nobody asked for it.

A filter narrows what is reported and mutated, never the cross-record evidence
used to classify it. Report matched numbers and any requested number the tree
does not have. Done only when a subject filter — or an explicit "everything" — is
fixed and echoed back.

## Phase 1 — Answer about the chosen subject (only after the subject is fixed)

**Pass the agreed subject filter to all three read-only entry points** from
`apps/dev/src/core/adr-triage.ts`, so every number reported is one the maintainer
asked to see:

1. **`triageAdrs`** — buckets every record as `keep`, `stale-reference`,
   `missing-supersession`, `merge-candidate`, `split-candidate`, or
   `archive-candidate`, with each entry's signals and reason. This is the
   **list** operation: report counts per bucket plus the entries in scope.
2. **`groupAdrs`** — the **group** operation, re-run under the filter so the
   report shows how the chosen slice sits inside its `index-section` and
   `subject-cluster` groups.
3. **`detectAdrInconsistencies`** — the **surface inconsistencies** operation. It
   reports `numbering-collision`, `dangling-supersede`, `supersession-cycle`,
   `index-drift`, `missing-supersession`, `stale-path`, and `subject-overlap`
   findings, each with its implicated numbers and one actionable line. Report a
   finding that reaches outside the slice when it implicates a record inside it —
   a dangling pointer is a fact about the pair, not about the filter.

Deep-read the flagged records in the slice before proposing anything about them.
Done only when the maintainer has seen the buckets, the groups, and the
inconsistency list for the subject they chose — and **nothing outside it**.

## Phase 2 — Agree the operations (anchored on the slice just reported)

**Name each operation with its exact inputs** — which ADRs, which numbers are
minted, which are archived, which pointers are written, which INDEX bullets
move. Recommend the operation you would run and say why in one sentence.

| Operation | What it does | Primitive |
|---|---|---|
| **add** | mint a new record at the next free number | `planIndexEntry` for its bullet |
| **remove** | retire a record; prefer archive, delete only when asked outright | `planArchiveMove` |
| **rewrite** | edit any section of a live record, `## Decision` included | direct edit + `planIndexEntry` |
| **merge** | consolidate N records into one successor, archiving the originals | `planMerge` |
| **split** | replace one overloaded record with N focused ones | `planSplit` |
| **archive** | status a terminal record and `git mv` it to `.red/adr/archive/` | `planArchiveMove` |
| **renumber** | move a record to a free number — filename, H1, and bullet together | `planRenumber` |
| **re-index** | place or move one bullet under the right INDEX theme | `planIndexEntry` |

Rewriting a `## Decision` in place is permitted — the maintainer owns the
record. Say plainly when supersede-and-replace would preserve more history and
let them choose; do not impose it.

Three narrower planners cover metadata-only work: `planStatusAndSuccessor` sets
a terminal status and successor pointer, `planIndexArchive` resyncs one INDEX
bullet into the Archived section, and `planStalePathFix` repairs a backticked
path that moved.

## Phase 3 — Confirm once (only for a destructive or wide batch)

**Ask exactly one question, listing the whole batch:**

> Apply these N operations now? (`apply` / `stop`) — M records mutated, K archived.

`apply` authorises the entire listed batch. `stop`, silence, or a requested
change cancels it: re-plan, show the replacement in full, ask once more. A
non-destructive, narrow run — list, group, surface inconsistencies, re-index,
or a single add — needs no gate at all.

## Phase 4 — Apply with the shipped helpers

Immediately before writing, verify each target's working-tree content still
matches what produced the plan; drift cancels the confirmation, so re-detect and
re-plan. Then apply through the matching helper:

- `applyArchiveMove` for a `planArchiveMove` result;
- `applyStatusAndSuccessor` for a `planStatusAndSuccessor` result;
- `applyIndexArchive` for a `planIndexArchive` result;
- `applyStalePathFix` for a `planStalePathFix` result;
- `applyRenumber` for a `planRenumber` result;
- `applyComposite` for a `planSplit` or `planMerge` result.

The injected filesystem and git adapters must perform real writes and real
`git mv`; keep their compensation behavior, which rolls a failed split or merge
back in reverse. Stop at the first apply failure and report it — never continue
into later operations on a half-applied tree.

## Phase 5 — Verify, then land

**Re-run all three read-only entry points against the resulting tree**, under the
same subject filter, and show the post-apply buckets, groups, and remaining
inconsistencies. Run the ADR governance and operation tests. Inspect the exact
diff before committing.

Land through the repo's normal flow: commit in the worktree, push the branch,
open the PR. When the session ends, run the
shared end-of-session doc-landing finalizer in
[`/start`'s DOC-LANDING-FINALIZER.md](../start/DOC-LANDING-FINALIZER.md); it
stays silent when no docs changed.

## Escape hatch — offer `/to-spec` only for genuinely large batches

When the agreed work is too large to land coherently in one session — a
collection-wide renumbering, a restructure spanning dozens of records — **offer**
`/to-spec` so `/to-tickets` and `/afk` can slice it. The maintainer chooses. A
declined offer means this session does the work. `/to-spec` is never a gate and
never the default route.

</what-to-do>

<supporting-info>

## Composition map

| Operation | Reuses |
|---|---|
| subject interview | `groupAdrs` unfiltered — its group titles are the choices |
| list | `triageAdrs` + its subject filter and bucket report |
| group | `groupAdrs` — INDEX sections then title-term clusters |
| surface inconsistencies | `detectAdrInconsistencies` — seven finding kinds |
| add / re-index | `planIndexEntry` |
| archive / remove | `planArchiveMove` + `applyArchiveMove` |
| merge | `planMerge` + `applyComposite` |
| split | `planSplit` + `applyComposite` |
| renumber | `planRenumber` + `applyRenumber` |
| rewrite | direct edit, with `planStalePathFix` for moved paths |
| landing | shared `DOC-LANDING-FINALIZER.md` |

## Inconsistency kinds and their usual cure

| Kind | Usual cure |
|---|---|
| `numbering-collision` | `planRenumber` the later record onto a free number |
| `dangling-supersede` | fix the pointer, or mint the missing successor |
| `supersession-cycle` | decide which record is terminal, then re-status the pair |
| `index-drift` | `planIndexEntry` to add the bullet, or drop the orphan bullet |
| `missing-supersession` | `planStatusAndSuccessor` on the superseded record |
| `stale-path` | `planStalePathFix` with the verified replacement path |
| `subject-overlap` | `planMerge`, or record why the two records stay distinct |

## Boundary examples

- "Review the ADRs" names no subject: derive the groups, offer them with counts,
  and report only the one the maintainer picks. It never becomes a
  whole-collection dump.
- "Group the ADRs by theme" is an explicit whole-collection ask — the everything
  choice, already made. Run `groupAdrs` unfiltered and report: no question, no
  gate, no mutation, no Spec.
- "Fix the rsp ADRs" already carries its subject: resolve it to
  `{ kind: "text", query: "rsp" }`, echo the matched numbers, and skip Phase 0's
  question entirely.
- "0112 is wrong now" is a rewrite or a supersede, and this session does it.
  Ask which shape the maintainer wants; do not default to supersede-and-replace.
- "Merge 0034 and 0060" runs `planMerge` + `applyComposite` after one
  confirmation — the merge lands in this session, never as deferred backlog.
- A split whose boundary is genuinely unclear earns one question about the
  boundary, then the split. It does not earn a deferral.
- Renumbering a collided pair is a single confirmed batch: `planRenumber` per
  record, INDEX bullets carried along by the same plan.
- Deleting a record outright is only correct when the maintainer asks for a
  delete rather than an archive; archive preserves history and is the default
  reading of "remove".

## Sibling doctors

`/red-doctor` owns process and adoption drift; `memory:doctor` owns graph
health; this skill owns the decision collection. Three axes, three doors — do
not expand into the other two.

</supporting-info>
