---
name: to-tickets
working-mode: spec-driven
description: Break a plan or Spec into independently-grabbable Tickets on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into Tickets, create implementation Tickets, or break down work into Tickets.
argument-hint: "[--tags a,b]"
---

# To Tickets

**Break a plan into independently-grabbable vertical slices and publish them to the issue tracker.**

The issue tracker and triage label vocabulary should have been provided to you — if not, ask the user to run `/red-setup` and stop.

<what-to-do>

### Step 1 — Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its **full body and all comments** before continuing.

### Step 2 — Explore the codebase (only if you haven't already)

Skip if the current conversation already explored. Otherwise: read enough to understand the current state. Issue titles and descriptions **must** use the project's domain glossary vocabulary. Respect ADRs in the area you're touching.

### Step 3 — Draft vertical slices

Break the plan into **tracer-bullet** issues. Each slice cuts end-to-end through every layer.

Apply the rules in `<supporting-info>` literally. The cardinal one: **vertical, not horizontal.**

Mark each slice with its routing class:

(i) **AFK** — mergeable without human decision
(ii) **HITL** — requires an architecture call or human judgment (design review, external access)

Prefer AFK over HITL wherever possible.

**File disjunction check — serialize entangled slices.** After assigning routing classes, inspect every pair of parallel slices (those with no `req:N` edge between them) for file-set overlap. Two slices are *entangled* when they both write to the same file(s). Entangled concurrent slices produce a merge conflict that no runtime resolves — the conflict is inherent, not recoverable. Serialize them: add a `req:N` dependency edge from the later slice to the earlier one so only one is `ready-for-agent` at a time. Parallel slots belong exclusively to *file-disjoint* slices that touch non-overlapping file sets. This is the canonical serialization mechanism; the AFK fleet width is calibrated from the resulting disjunction structure (see `/afk fleet` docs).

### Step 4 — Quiz the user (mandatory — do not skip)

Present the proposed breakdown as a numbered list. For each slice show:

- **Title** — short descriptive name
- **Type** — HITL / AFK
- **Blocked by** — which other slices (if any) must complete first
- **User stories covered** — which user stories this addresses (if the source has them)

Then ask, **explicitly**:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?
- Are the correct slices marked HITL vs AFK?

**Iterate until the user approves the breakdown.** Do not advance to Step 5 on silence or implicit approval.

### Step 5 — Cascade gate

**Verify referenced `.red/` docs are landed on `origin/{base}` before publishing** — AFK workers branch from `origin/{base}` and cannot see the primary checkout's working-tree edits, so never publish while docs are unlanded.

1. `git fetch origin`, then compare the `.red/` docs (`.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`, `.red/adr/**`) between the primary working tree and `origin/{base}` (base resolved lock > pin > main). "Landed" means reachable from `origin/{base}`, not merely present on disk — origin-first comparison, mirroring the `/adr-editor` convention.
2. **On mismatch:** run the doc-landing procedure from the `/start` end-of-session finalizer (canonized by ADR 0092) first, then continue to Step 6.
3. **If landing is impossible** (no network, no push access): abort — never publish while docs are unlanded. State clearly which files must be landed and stop.

### Step 6 — Publish in dependency order

For each approved slice, publish a new issue. Use the issue template in `<supporting-info>`.

- Publish in **dependency order** (blockers first) so you can reference real issue identifiers in each "Blocked by" field
- Tag only currently-unblocked AFK slices with the canonical `ready-for-agent` triage label (mapped string from `/red-setup`).
- If an AFK slice has open blockers, publish it as `blocked:dependency` + one `req:N` label **per blocker** (NOT `ready-for-human` — a dependency-blocked slice is healthy and must never page a human). Also create the tracker-native blocked-by relationship for each blocker using `/red-setup` issue-tracker-github *Dependency & hierarchy operations*. The native blocked-by relationship is the human surface; req:N labels remain the machine truth for `/afk` close cascade, boot sweep, and gate census. Keep the strict `## Blocked by` task list in the body as the ADR 0094 AFK boot-sweep fallback and human-facing mirror. `req:N` labels are created on demand (`gh label create req:<n>` if missing). `/afk` auto-promotes the issue to `ready-for-agent` the moment its last dependency closes (event-driven close cascade, with the boot sweep as a safety net). See `/red-setup` triage-labels *Dependency Edges* and ADR 0094.
  - **`req:N` targets must be executable slices, never a Spec** (authoritative statement + rationale in Hard rules below). Before creating each `req:N` label, check the target with `gh issue view N --json labels`: if #N carries `type:spec`, **refuse the edge** and re-point it at the Spec's concrete executable slice(s) instead (the child issues carrying `spec:N`); when the Spec has no slices yet, first create the concrete slice the dependent actually waits on, then point `req:N` at that slice.
- If a slice is HITL, publish it as `ready-for-human`. Do **not** include a literal `## Blocked by` section unless it should be auto-promoted to AFK after blockers close; use `## Current blocker` / `## Human decision needed` for gates, measurements, and decisions where closing a referenced issue is not enough to make the slice delegable.
- **Territory tag labels inherit from the parent Spec.** Stamp every child Ticket with the parent Spec's `tag:<value>` labels; an explicit `--tags a,b` on this invocation extends/overrides that inherited set. Create each missing `tag:<v>` label on demand (`gh label create "tag:<v>"` if missing — same pattern as `req:N`). Tag labels scope which fleet drains the Ticket (`/afk --tags`, AND semantics); they never drive lifecycle transitions.
- If the parent is a Spec (carries `type:spec` + `needs-slicing`), tag every child with `spec:{N}` referencing the parent and create the tracker-native sub-issue relationship from the parent Spec to the child Ticket using `/red-setup` issue-tracker-github *Dependency & hierarchy operations*. The native sub-issue relationship is the human surface; `spec:{N}` remains the label contract. After all slices are published, remove `needs-slicing` from the parent Spec. Never remove `type:spec` — it is a permanent type marker. Never apply `ready-for-agent` to the parent Spec itself.

### Hard rules — do not break these

- ❌ Do **not** mark two slices as parallelizable when they write to the same file(s) — that is a file-entanglement merge conflict waiting to happen at landing. Add `req:N` edges to serialize them instead; file-disjoint slices run in parallel, entangled ones run serial.
- ❌ Do **not** publish until the user explicitly approved the breakdown in Step 4
- ❌ Do **not** modify or close any parent issue
- ❌ Do **not** create horizontal-slice issues ("the schema layer", "the API layer", "the UI layer")
- ❌ Do **not** invent label strings — use the mapping from `/red-setup`
- ❌ Do **not** create a `req:N` edge whose target #N is a `type:spec` — dependency edges must point at executable slices. A Spec closes only after a manual bookkeeping step long after its substance ships (#907/#928: 46/46 children closed, Specs still open), so a `req:<Spec>` edge strands the dependent in `blocked:dependency` forever. Re-point at the Spec's `spec:N` children, or, when the Spec has no slices yet, first create the concrete slice the dependent waits on and point `req:N` at that.
- ❌ Do **not** "clean up" controlled redundancy between native tracker edges and labels/body text. Do not clean up either side: native sub-issue relationship and native blocked-by relationship edges are for humans; req:N labels remain the machine truth; the `## Blocked by` body fallback stays for compatibility.
- ❌ Do **not** inline file paths or code snippets in issue bodies — they go stale. The one exception is in `<supporting-info>` (decision-rich prototype output)
- ✅ **Do** publish in dependency order so "Blocked by" fields point at real issue IDs
- ✅ **Do** prefer many thin slices over few thick ones

</what-to-do>

<supporting-info>

## Vertical-slice rules

<vertical-slice-rules>
- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Prefer many thin slices over few thick ones
- Parallel slices must be file-disjoint; file-overlapping slices get `req:N` serialization edges so they run serial, not concurrent
</vertical-slice-rules>

A horizontal slice ("build the schema for all tables") cannot be demoed and cannot be merged independently — it produces issues that block each other unnecessarily and tests imagined behaviour.

## Issue body template

<issue-template>
## Parent

A reference to the parent Spec on the issue tracker, written as a literal `Spec #N` line (if the source was an existing Spec, otherwise omit this section). The `/afk` pin-reader parses this exact `Spec #N` form to inherit the parent's `branch:` pin — keep the word `Spec` and the `#N` reference literal.

## What to build

A concise description of this vertical slice. Describe the end-to-end behaviour, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. **Exception**: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Running `<focused command>` passes for this slice.
- [ ] The failing fixture or reproduction demonstrates the behavior before the implementation.
- [ ] The pinned observable behavior remains true after re-running the command or workflow.

## Blocked by

- [ ] #123
- [ ] #456

Format: one GitHub task-list tracking entry per blocker, `- [ ] #N`. This is not GitHub's issue-dependencies widget. Its job is the ADR 0094 body fallback: the `/afk` boot sweep parses this exact section to auto-promote issues whose blockers have all closed, and humans still get a readable mirror in the issue body. Keep the heading literal (`## Blocked by`, capitalised, no extra punctuation) and the format strict.

This section is the body fallback required by ADR 0094. When the tracker supports native edges, publish the native blocked-by relationship too; keep this section anyway so older paths and audits retain the same source shape.

Omit the section entirely (do not write "None") if the slice has no blockers.

For a human gate, use this shape instead:

```markdown
## Current blocker

<!-- red:blocker-state v1 -->
status: blocked
kind: decision
ref: #123
summary: The dependency closed, but the measurement did not prove the required win.
next: Human must decide whether to stop, redesign, or continue anyway.
<!-- /red:blocker-state -->
```

</issue-template>

## Wide refactors — expand → migrate → contract

**When a change is blast-radius-wide** (a rename, signature change, or API move touching dozens of call sites), a single vertical slice cannot both stay small and stay mergeable. Slice it as an **expand–contract** chain instead — three (or more) Tickets that each merge green on their own:

1. **Expand.** Introduce the new form *alongside* the old one — new function/flag/label/type added, old one untouched and still authoritative. Nothing calls the new form yet. This Ticket merges without changing any behaviour.
2. **Migrate.** Move call sites onto the new form, in one Ticket per independently-verifiable batch (by package, by layer, or by directory). Each batch merges green because the old form still exists as a fallback. Many thin migration Tickets beat one giant one — a failed batch never blocks the others.
3. **Contract.** Once every call site is migrated, remove the old form in a final Ticket. This is the only Ticket that deletes the old vocabulary, and it is `blocked:dependency` on all the migration Tickets (one `req:N` per batch).

**Big-bang exception.** Some flips must NOT expand–contract — when the two forms cannot coexist (a single atomic label/flag rename with no transition window, e.g. ADR 0093's vocabulary flip), slice it as one Ticket that changes definition + call sites + tests together, and say so explicitly in the Ticket body so a reviewer does not expect a fallback. Prefer expand–contract; reach for big-bang only when coexistence is genuinely impossible or the maintainer decided against a transition window.

</supporting-info>
