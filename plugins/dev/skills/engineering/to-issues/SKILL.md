---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices. Use when user wants to convert a plan into issues, create implementation tickets, or break down work into issues.
---

# To Issues

**Break a plan into independently-grabbable vertical slices and publish them to the issue tracker.**

The issue tracker and triage label vocabulary should have been provided to you — if not, ask the user to run `/setup-red-skills` and stop.

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

### Step 5 — Publish in dependency order

For each approved slice, publish a new issue. Use the issue template in `<supporting-info>`.

- Publish in **dependency order** (blockers first) so you can reference real issue identifiers in each "Blocked by" field
- Tag only currently-unblocked AFK slices with the canonical `ready-for-agent` triage label (mapped string from `/setup-red-skills`).
- If an AFK slice has open blockers, publish it as `blocked:dependency` + one `req:N` label **per blocker** (NOT `ready-for-human` — a dependency-blocked slice is healthy and must never page a human), keeping the strict `## Blocked by` task list in the body as the human-facing mirror. `req:N` labels are created on demand (`gh label create req:<n>` if missing). `/afk` auto-promotes the issue to `ready-for-agent` the moment its last dependency closes (event-driven close cascade, with the boot sweep as a safety net). See `/setup-red-skills` triage-labels *Dependency Edges*.
  - **`req:N` targets must be executable slices, never a PRD.** Before creating each `req:N` label, check the target with `gh issue view N --json labels`: if #N carries `type:prd`, **refuse the edge** and re-point it at the PRD's concrete executable slice(s) instead (the child issues carrying `prd:N`). A PRD closes only after a manual bookkeeping step long after its substance ships (#907/#928: 46/46 children closed, PRDs still open), so a `req:<PRD>` edge strands the dependent in `blocked:dependency` forever. When the PRD has no slices yet, first create the concrete slice the dependent actually waits on, then point `req:N` at that slice.
- If a slice is HITL, publish it as `ready-for-human`. Do **not** include a literal `## Blocked by` section unless it should be auto-promoted to AFK after blockers close; use `## Current blocker` / `## Human decision needed` for gates, measurements, and decisions where closing a referenced issue is not enough to make the slice delegable.
- If the parent is a PRD (carries `type:prd` + `needs-slicing`), tag every child with `prd:{N}` referencing the parent and, **after** all slices are published, remove `needs-slicing` from the parent PRD. Never remove `type:prd` — it is a permanent type marker. Never apply `ready-for-agent` to the parent PRD itself.

### Hard rules — do not break these

- ❌ Do **not** publish until the user explicitly approved the breakdown in Step 4
- ❌ Do **not** modify or close any parent issue
- ❌ Do **not** create horizontal-slice issues ("the schema layer", "the API layer", "the UI layer")
- ❌ Do **not** invent label strings — use the mapping from `/setup-red-skills`
- ❌ Do **not** create a `req:N` edge whose target #N is a `type:prd` — dependency edges must point at executable slices; re-point at the PRD's `prd:N` children (or a named slice created for the dependent)
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
</vertical-slice-rules>

A horizontal slice ("build the schema for all tables") cannot be demoed and cannot be merged independently — it produces issues that block each other unnecessarily and tests imagined behaviour.

## Issue body template

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behaviour, not layer-by-layer implementation.

Avoid specific file paths or code snippets — they go stale fast. **Exception**: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- [ ] #123
- [ ] #456

Format: one GitHub task list entry per blocker, `- [ ] #N`. GitHub renders this as a native dependency widget ("Tracked by 0/N"), checkboxes auto-mark when the referenced issue closes. The `/afk` boot sweep parses this exact section to auto-promote issues whose blockers have all closed — keep the heading literal (`## Blocked by`, capitalised, no extra punctuation) and the format strict.

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

</supporting-info>
