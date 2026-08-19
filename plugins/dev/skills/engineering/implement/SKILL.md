---
name: implement
working-mode: interactive
description: "Implement a Spec or set of issues interactively — guided, human-driven counterpart to the autonomous /afk fleet."
disable-model-invocation: true
---

# Implement

<what-to-do>

**Interactive Spec execution — you drive, the agent assists; for unattended autonomous execution, use `/afk` instead.**

`/implement` is the human-in-the-loop complement to `/afk`:

| | `/implement` | `/afk` |
|---|---|---|
| **Driver** | You — interactive, step-by-step | Autonomous fleet, no human in the loop |
| **Scope** | One Spec / issue set, right now | Drains the full `ready-for-agent` queue |
| **Worktree** | Dedicated `.red/tmp/worktrees/manual/<slug>` worktree | Isolated worktree per issue, sandcastle |
| **Finish** | You run `/retake` when satisfied | Agent merges, closes, claims next issue |

Use `/implement` when you want to implement a Spec or issues yourself — with test-first discipline and review — but need the agent to guide each step. Use `/afk` when you want the fleet to work unsupervised.

### Steps

1. **Agree the scope.** Identify the Spec or issues to implement. If they are not yet on the tracker, run `/to-tickets` to break the plan down first.

2. **Work the issues — `/tdd` at pre-agreed seams.** For each issue (or logical seam inside a larger issue), invoke `/tdd`: write the failing test first, then the minimum code to pass it, then refactor. The seams are the boundaries you agreed in Step 1 — do not cross seam boundaries before the current slice is GREEN.

3. **Run typechecking and isolated test files regularly.** After each `/tdd` cycle: `pnpm tsc --noEmit` and the relevant test file(s). Fix any failure before proceeding.

4. **Run the full test suite once at the end.** Only after all issues in scope are implemented and individually GREEN: `pnpm test` (or the project's equivalent). All must pass before the next step.

5. **Review with `/code-review`.** When the full suite is green, invoke `/code-review` to review the work. Address every finding before committing.

6. **Finish with `/retake`.** Commit the work in the worktree (never on the primary branch), push, and run `/retake` to adopt the branch into the reconcile lane — it validates through the shared gate and lands. Close the linked issues when done. (For a brand-new one-off demand that doesn't need this interactive loop, dispatch `/go "<demand>"` instead — it handles worktree, gate, and PR end-to-end.)

### Hard rules

- ❌ Do **not** implement on the primary branch or a sibling checkout — work in `.red/tmp/worktrees/manual/<slug>` and finish via `/retake`.
- ❌ Do **not** skip `/tdd`; writing code before a failing test is undefined behaviour for this skill.
- ❌ Do **not** run `/code-review` while any test is red.
- ✅ **Do** let `/to-tickets` decompose large Specs before starting — smaller seams mean smaller merge risk.
- ✅ **Do** run typechecking after every cycle, not just at the end.

</what-to-do>

<supporting-info>

## Worktree convention

All implementation work lives in a dedicated worktree under the registered
manual-worktree lane `.red/tmp/worktrees/manual/<slug>`, never on the primary
branch or in a sibling directory. The `<slug>` is a lowercase kebab-case task
name. Create one with the dev loop:

```
git worktree add .red/tmp/worktrees/manual/<slug> -b feat/<slug> origin/main
```

**Resuming an EXISTING branch checks out the remote ref, not the local one.**
The bare `git worktree add <dir> <branch>` resolves the LOCAL ref, which can
trail `origin/<branch>`; work built on that stale tip comes back from the push as
`non-fast-forward`. Pin the checkout to the remote:

```
git fetch origin <branch>
git worktree add .red/tmp/worktrees/manual/<slug> -B <branch> origin/<branch>
```

`/retake` expects hand-worked worktrees to live under
`.red/tmp/worktrees/manual/<slug>`. After the adopted branch lands, the worktree
is pruned automatically.

## Spec / issue model

Issues live on GitHub (`reddb-io/red-skills`). A Spec is itself a GitHub issue labeled `type:spec`. Run `/to-spec` to create one from the current conversation; run `/to-tickets` to break it into independently-grabbable slices.

</supporting-info>
