---
name: retake
working-mode: spec-driven
description: Pick one issue back up — reconstruct where it stands (linked PRs, branches, worktrees, uncommitted or unpushed work, HITL state, active blocker), report that state, then execute the one right action — a plain requeue into `ready-for-agent`, an `--adopt-branch` landing through the no-agent gate, or a handoff to `/hitl`. Use when the user invokes `/retake #123`, asks to resume or recover an issue, wants to requeue a parked issue, or has hand-done work on a branch that needs to land.
argument-hint: "#ISSUE [--apply] [--json] [--repo OWNER/REPO] [--pr-limit N]"
---

# /retake

**Diagnose before you act — a requeue fired at an issue whose work already sits finished in a dirty worktree just spawns a second agent to redo it.**

`/retake` is one skill with two halves. The **diagnosis** half reconstructs the
issue's real state from GitHub and the local filesystem. The **action** half
executes exactly one transition out of that state. Never skip the first half:
the label claims `ready-for-human`, but the truth is in the worktree.

<what-to-do>

## 1. Diagnose — Reconstruct The State

**Drive the `rs_dev` MCP; the CLI is the fallback transport.** The diagnosis is
the `retake` tool — `{issue, repo?, prLimit?}` — which returns the full
reconstruction (tracker state, PRs, branches, worktrees, recommendation) as a
structured value. The tool surface, host tool-name prefix rule, and mutation
contract live in [`../afk/MCP.md`](../afk/MCP.md); do not restate them here.

When the MCP is unreachable, name that and fall back to the `red-skills-dev`
CLI — the same engine over the same cores. Resolve the runtime through the
shared contract in [`../_report-runtime/WRAPPER.md`](../_report-runtime/WRAPPER.md)
(canonical ADR 0091 npm direct-run; an installed shim on `PATH` is only a
warm-cache optimization):

```bash
npx -y -p @reddb-io/red-skills@<version> red-skills-dev retake 123
```

The runtime accepts `123` and `#123`; quote `'#123'` when a shell would read it
as a comment. Add `--json` when another tool or agent consumes the state.

The report answers six questions, in this order:

1. **What does the tracker say?** Issue state, labels, the active
   `## Current blocker` in the body, and whether those two agree. A `blocked:*`
   label without a matching blocker section is a **label/body mismatch** — that
   issue belongs to `/hitl`, not to you.
2. **Is there a PR?** Linked PRs from recent PRs plus `#ISSUE` search hits, with
   their check and review state.
3. **Is there a branch?** Local and remote branches carrying the issue number.
4. **Is there a worktree?** Matching local worktrees, each marked `clean` or
   `dirty`.
5. **Is the work already done locally?** A dirty worktree holds uncommitted
   work; a branch ahead of its remote holds unpushed commits. Either one means
   **the code exists and nobody knows** — say so loudly.
6. **What is the blocker really?** `blocked:validation` and `blocked:spec` are
   retryable. Anything else is a pending human decision.

## 2. Report — Say Where The Issue Stands

Present the reconstruction before proposing anything. Use this form:

```text
Issue #123 — <title> [<labels>]
Tracker:   <state>, blocker: <kind or none>, label/body: agree | mismatch
PR:        #456 <checks> <reviews>   (or: none)
Branch:    <name> (<n> ahead / <n> behind origin)   (or: none)
Worktree:  <path> — clean | dirty (<n> uncommitted files)   (or: none)
Verdict:   <one sentence: is the work done, partial, or unstarted?>
Action:    <the single next command>
```

**The verdict is the point.** "Work is committed on `afk/123-foo`, pushed, PR
#456 green" and "work is unstarted, only a label is parked" demand opposite
actions from an identical set of labels.

## 3. Act — Execute Exactly One Transition

Pick by verdict, never by label alone:

| Verdict | Action |
| --- | --- |
| Pending human decision, mixed `blocked:*` labels, or label/body mismatch | `/hitl #ISSUE` — stop here, do not requeue |
| Parked `blocked:validation` / `blocked:spec`, work unstarted, guidance in hand | plain requeue (below) |
| Work done on a branch — committed and pushed | adopt-branch landing (below) |
| Open PR with failing checks or changes requested | fix the PR branch first; neither command lands a red PR |
| Dirty worktree | commit and push inside that worktree, then re-run `/retake` |

### Plain requeue — put a parked issue back in the queue

The `requeue` tool (MUTATING) — `{issue, guidance}` — executes one atomic
transition: archive the active `## Current blocker` into `## Resolved blockers`,
post the guidance as an auditable `directive` comment, drop `ready-for-human`
and every `blocked:*` label, add `ready-for-agent`. CLI fallback:

```bash
npx -y -p @reddb-io/red-skills@<version> red-skills-dev requeue 123 --guidance "Retry with the documented guidance; the gate flake is fixed."
```

### Adopt-branch landing — validate and land hand-done work

The same `requeue` tool with `adoptBranch` set routes the branch through the
no-agent landing lane. CLI fallback:

```bash
npx -y -p @reddb-io/red-skills@<version> red-skills-dev requeue 123 --adopt-branch my-feature-branch --guidance "Manual implementation complete; run gate."
```

After the requeue transition, the branch routes through the **no-agent landing
lane** (ADR 0055). The shared feedback gate validates it with no agent re-run;
green lands it through `doLanding` and closes the issue; red parks it back to
`ready-for-human` with `blocked:validation` plus the real failing checks; a
branch with no commits versus base exits 0 with a note. An adopted branch and an
AFK branch pass the same gate authority.

`--guidance` is required in both modes — it records the human decision. Use
`--dry-run` to print the planned transition without mutating, and `--json` for
structured output.

### `--apply` — safe local setup only

`npx -y -p @reddb-io/red-skills@<version> red-skills-dev retake 123 --apply` runs only the safe local `git`
operations
the diagnosis selected: create a missing manual worktree under
`.red/tmp/worktrees/manual/<slug>`, recreate it from a matching branch, or fetch
a PR head branch into a fresh worktree. It then prints the next `cd`, `requeue`,
or `/go` command.

- ✅ `--apply` is non-destructive by construction — local `git` setup, nothing else.
- ❌ Do **not** expect `--apply` to merge, close issues, edit labels, run the requeue transition, or move the primary checkout's branch. It does none of them.
- ❌ Do **not** flip labels by hand instead of running requeue. AFK preflight re-reads the active blocker and re-parks the issue, so a hand-flipped label is a silent no-op retry loop (#850).

</what-to-do>

<supporting-info>

## Why a label flip alone fails

A validation or spec failure parks an issue with three things at once:
`ready-for-human`, a `blocked:*` label, and an active `## Current blocker` in
the body. AFK preflight reads that blocker **before any work starts**, so an
issue whose labels say `ready-for-agent` while its body still carries a blocker
is re-parked immediately. The blocker must clear in the same transition that
flips the labels. Producing that single transition is what the `requeue` command
exists for.

## `/retake` vs `/hitl` — the decision boundary

**Stay in `/retake`** when the decision is already made: the issue is
`blocked:validation` or `blocked:spec` with no other `blocked:*` label, the label
kind and the active blocker kind agree, and you hold the retry guidance. Or when
you have a hand-done branch to adopt. Or when you have reviewed a protected diff
and want to land it.

**Hand to `/hitl`** when the pending human decision still has to be *extracted* —
it interviews the maintainer, decides delegability, then clears the blocker and
requeues. Hand over any issue carrying mixed `blocked:*` labels, a label/body
mismatch, or a blocked kind outside `validation` / `spec`
(`blocked:decision`, `blocked:stalled`). Both paths end in the same safe state;
`/retake` is the informed shortcut, `/hitl` is the interview.

## Where the work lives

Hand-done work belongs in the manual-worktree lane
`.red/tmp/worktrees/manual/<slug>`, never on the primary checkout's branch. Use a
lowercase kebab-case slug, usually the issue number plus a short task name. When
the diagnosis finds no local state at all, the next action is a fresh worktree
from `origin/main` — or, for a brand-new one-off demand that never was an issue,
`/go "<demand>"` instead of this skill. After an adopted branch lands through the
no-agent landing lane, its worktree is pruned automatically.

## See also

- `/hitl` — interactive decision extraction before requeueing
- `/go` — dispatch an untracked one-off demand end-to-end
- ADR 0055 — the no-agent landing lane (reconcile / doLanding)
- ADR 0081 — command topology; retake is the manual adoption path

</supporting-info>
