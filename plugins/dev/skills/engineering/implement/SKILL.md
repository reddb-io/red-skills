---
name: implement
description: "Implement a PRD or set of issues interactively — guided, human-driven counterpart to the autonomous /afk fleet."
disable-model-invocation: true
---

# Implement

<what-to-do>

**Interactive PRD execution — you drive, the agent assists; for unattended autonomous execution, use `/afk` instead.**

`/implement` is the human-in-the-loop complement to `/afk`:

| | `/implement` | `/afk` |
|---|---|---|
| **Driver** | You — interactive, step-by-step | Autonomous fleet, no human in the loop |
| **Scope** | One PRD / issue set, right now | Drains the full `ready-for-agent` queue |
| **Worktree** | Dedicated `.red/tmp/work-*` worktree | Isolated worktree per issue, sandcastle |
| **Finish** | You run `/requeue` when satisfied | Agent merges, closes, claims next issue |

Use `/implement` when you want to implement a PRD or issues yourself — with test-first discipline and review — but need the agent to guide each step. Use `/afk` when you want the fleet to work unsupervised.

### Steps

1. **Agree the scope.** Identify the PRD or issues to implement. If they are not yet on the tracker, run `/to-issues` to break the plan down first.

2. **Work the issues — `/tdd` at pre-agreed seams.** For each issue (or logical seam inside a larger issue), invoke `/tdd`: write the failing test first, then the minimum code to pass it, then refactor. The seams are the boundaries you agreed in Step 1 — do not cross seam boundaries before the current slice is GREEN.

3. **Run typechecking and isolated test files regularly.** After each `/tdd` cycle: `pnpm tsc --noEmit` and the relevant test file(s). Fix any failure before proceeding.

4. **Run the full test suite once at the end.** Only after all issues in scope are implemented and individually GREEN: `pnpm test` (or the project's equivalent). All must pass before the next step.

5. **Review with `/review`.** When the full suite is green, invoke `/review` to review the work. Address every finding before committing.

6. **Finish with `/requeue`.** Commit the work in the worktree (never on the primary branch), push, and run `/requeue` to adopt the branch into the reconcile lane — it validates through the shared gate and lands. Close the linked issues when done. (For a brand-new one-off demand that doesn't need this interactive loop, dispatch `/go "<demand>"` instead — it handles worktree, gate, and PR end-to-end.)

### Hard rules

- ❌ Do **not** implement on the primary branch or a sibling checkout — work in `.red/tmp/work-*` and finish via `/requeue`.
- ❌ Do **not** skip `/tdd`; writing code before a failing test is undefined behaviour for this skill.
- ❌ Do **not** run `/review` while any test is red.
- ✅ **Do** let `/to-issues` decompose large PRDs before starting — smaller seams mean smaller merge risk.
- ✅ **Do** run typechecking after every cycle, not just at the end.

</what-to-do>

<supporting-info>

## When to use `/implement` vs `/afk`

**Use `/implement`** when:
- You want to implement the PRD yourself and stay in control of each step.
- The work is complex or exploratory enough that you want to adjust direction mid-flight.
- The issues are not yet triaged / have no AGENT-BRIEF that `/afk` can consume.

**Use `/afk`** when:
- Issues are `ready-for-agent` (triaged, AGENT-BRIEF written).
- You want the fleet to work unattended across many issues at once.
- You want autonomous claim → worktree → gate → merge → close with no human steps.

## Worktree convention

All implementation work lives in a dedicated worktree under `.red/tmp/`, never on the primary branch or in a sibling directory. Create one with the dev loop:

```
git worktree add .red/tmp/work-<slug> -b feat/<slug>
```

`/requeue` expects the worktree to be under `.red/tmp/work-*/`. After the adopted branch lands, the worktree is pruned automatically.

## PRD / issue model

Issues live on GitHub (`reddb-io/red-skills`). A PRD is itself a GitHub issue labeled `type:prd`. Run `/to-prd` to create one from the current conversation; run `/to-issues` to break it into independently-grabbable slices.

</supporting-info>
