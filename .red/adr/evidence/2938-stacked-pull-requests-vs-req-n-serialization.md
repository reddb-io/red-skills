# Spike evidence: do stacked pull requests replace the `req:N` serialization?

Issue: #2938
Motivating Spec: #2900 (chains `2903 → 2904 → 2905 → 2906` and `2907 → 2908/2909 → 2910`)
Feature under study: GitHub stacked pull requests, public preview announced 2026-07-30
Observed: 2026-07-31, documentation only

Read-only spike. Nothing was installed, no workflow, skill or convention was
changed, and no stacked pull request was opened. This file is the report the
issue asked for; it adopts nothing.

## Sources

- [About stacked pull requests](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs)
- [Stacked pull requests (reference)](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests)
- [Stacked pull requests CLI commands](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands)
- [Changelog: stacked pull requests are now in public preview](https://github.blog/changelog/2026-07-30-stacked-pull-requests-are-now-in-public-preview/)
- [github/gh-stack](https://github.com/github/gh-stack)

Each answer below is marked **verified** (stated in the sources above or in this
repository's own code) or **open unknown** (not stated anywhere we could read).

## Recommendation

**Decline adoption now.** Re-open the question when three things are true, in
this order: merge-queue support for stacks is confirmed live on
`reddb-io/red-skills`; auto-merge is available for stack merges; and question 4
below has a documented answer.

The reason is not preview jitter. It is that stacking does not answer the
load-bearing question. **File-overlapping slices still cannot be written
concurrently** (Q1), so the `req:N` file-disjunction rule survives intact.
What stacking buys is a shorter review-and-merge tail — real, but far smaller
than the chain latency Spec #2900 pays.

And the larger part of that latency is ours, not GitHub's. Today a `req:N` edge
releases its dependent when the target issue **closes** — after implement, PR,
CI, merge and promote. The dependent only actually needs the predecessor's
**file writes**, which exist the moment the predecessor **pushes**. Moving the
dispatch gate from close to push, and branching the dependent Worker from the
predecessor's branch instead of `main`, collects most of the win described in
the issue, inside our own runtime, with no preview dependency and no new host
extension. That is the follow-up worth filing.

## 1. Does stacking let file-overlapping slices be worked concurrently?

**Verified: no — concurrently *reviewed*, not concurrently *written*.**

A stack is an ordered series in which each pull request targets the branch of
the one beneath it, and "pull requests must merge from the bottom up". Layer
`N+1`'s branch is *derived from* layer `N`'s branch, so layer `N`'s edits to a
shared file must already exist in the base layer `N+1` starts from. That is
serialization, expressed as branch topology instead of as a label.

If the lower layer keeps changing while the upper layer is being written — which
is what "concurrent" means — every lower commit breaks the stack's linear
history and forces a cascading rebase of every branch above it. Where both
layers touched the same lines, that rebase conflicts: `gh stack rebase` "pauses
and prints the conflicted files with line numbers", exits `3`, and waits for a
human to `git add` and `--continue`.

So the inherent conflict is not removed. It is **relocated and multiplied**:
from one merge conflict at landing, where AFK already has a
merge-conflict → `/hitl` route, to a rebase conflict on every lower-layer
commit, inside the Worker's own loop, where AFK has no route at all.

**Consequence: the `/to-tickets` file-disjunction rule survives unchanged.**
Two slices that write the same files still must not be `ready-for-agent` at
once.

## 2. What would `/to-tickets` emit instead?

Sketch only, as the issue requires — not implemented.

Today an ordered pair emits, for the dependent slice: `blocked:dependency`, one
`req:N` label per blocker, the native blocked-by relationship, and the
`## Blocked by` body list. Dispatch waits for #N to close.

Under stacking the *set* of ordered pairs would be identical — Q1 says the
overlap analysis does not change. Three things would change in what is emitted:

1. **A partial order becomes a total order.** `req:N` expresses a DAG; a stack
   is a single line. Spec #2900's two chains are two independent stacks, which
   is fine, but a slice with two blockers in different chains has no stack
   representation and would keep a `req:N` edge. `/to-tickets` would have to
   emit both vocabularies and decide which governs.
2. **Stack identity and position** would join the labels — the chain a slice
   belongs to and its ordinal — because the branch topology, not the label, is
   what actually enforces order.
3. **The dispatch gate moves from close to push.** The Worker for layer `N+1`
   branches from layer `N`'s branch and its PR targets that branch. This, not
   the stack object, is where the latency is recovered.

**The file-disjunction rule becomes:** file-disjoint slices stay parallel and
land as independent PRs; file-overlapping slices become an ordered stack whose
order *is* the write order, released on the predecessor's push rather than its
close. The rule does not weaken — the same pairs are still serialized.

Point 3 is available without stacked PRs. Points 1 and 2 are pure cost.

## 3. What does an AFK Worker need to open a stacked PR?

**Verified for the commands a Worker would need; one gap.**

Prerequisites are host state, not repository state: `gh extension install
github/gh-stack`, `gh` v2.0+, authenticated. That is one more thing the
`redskilled` host must provision and one more version to pin.

Non-interactive support, from the CLI reference:

| Command | Headless? | Note |
| --- | --- | --- |
| `gh stack init [branches] --base <trunk>` | yes | explicit branch names skip the prompt |
| `gh stack add <branch> -m <msg>` | yes | |
| `gh stack submit --auto` | yes | `--auto` skips the editor; PRs are drafts by default, `--open` marks ready |
| `gh stack push` | yes | per-branch `--force-with-lease` |
| `gh stack sync` | yes, fail-closed | "aborts on divergence in CI" — nothing pushed or updated |
| `gh stack view --json` | yes | machine-readable stack state |
| `gh stack link` | yes | reconstructs a stack from branches/PRs, no local state |
| `gh stack merge --yes` | yes | |
| `gh stack modify` | **no** | full-screen TUI; no non-interactive mode |

`gh stack modify` being human-only means any stack *restructuring* — drop,
reorder, fold, insert — is permanently outside an AFK Worker's reach. A Worker
can build a stack and can merge one; it cannot repair one's shape.

Exit codes are machine-readable and would classify cheaply: `3` rebase conflict,
`8` stack locked by another process, `9` stacked PRs not enabled for the
repository, `10` modify session interrupted, recovery required.

**Cost to a headless run.** One host-level extension install. Then, per
lower-layer commit, a cascading rebase and a force-push of *every* branch above
it — and every force-push re-runs required checks on that layer's PR. A
four-deep chain multiplies branch pushes and CI runs by up to four per
lower-layer edit. The issue prices the chain's serial round trips but not this;
on a repository whose checks gate every merge, it is not negligible.

## 4. How does a dead Worker mid-stack behave?

**Open unknown.** No page in the sources describes a stack layer whose pull
request is closed without merging, whose branch is deleted, or whose author
abandons it. Verified absent from the About page, the reference, and the CLI
reference.

What the sources do establish, and what it implies for our most expensive
recurring failure:

- **Local tracking state dies with the worktree.** `gh stack checkout` "fetches
  remote stacks and resolves local/remote conflicts" and `gh stack unstack
  --local` removes local tracking only, so the stack has a local component. A
  dead Worker's worktree takes it.
- **Server-side recovery exists, unproven for us.** `gh stack link` "does not
  store or modify any gh stack local tracking state" and rebuilds a stack from
  branch or PR numbers; `gh stack checkout` re-fetches a remote stack. So a
  fresh Worker could in principle adopt an orphaned stack.
- **There are states that need explicit recovery.** Exit `8` (stack locked by
  another process) and exit `10` (modify session interrupted; recovery required)
  say so directly. A Worker killed at the wrong moment can leave one, and
  nothing in AFK knows how to clear it.
- **Blast radius grows from one branch to a whole chain.** Today a dead Worker
  orphans one branch, recoverable with a single `gh pr create` — that is exactly
  what `apps/dev/src/commands/orphan-branches.ts` exists to do. In a stack,
  because merges go bottom-up, a dead *middle* Worker leaves every layer above
  it unmergeable. One death parks the chain.

We would be inheriting a strictly worse version of a failure we already pay for,
with no documented recovery path. This is the second-strongest reason to wait.

## 5. Merge queue interaction

**Verified in design; unverified in availability for this repository.**

The changelog is explicit that this is a rollout: "Merge queue support for
stacked pull requests is rolling out progressively over the coming weeks." The
documentation, meanwhile, already describes the finished behaviour — stacks are
"merge-queue aware", and when the base branch uses a queue the stack is added to
the queue instead of merging directly; the queue chooses the merge method and
`--merge-method`, `--squash`, `--rebase` and `--merge` "are ignored with a
warning"; ejecting one pull request ejects every layer above it; a merge group
may exceed its configured maximum size by up to 50 percent to keep a stack
together, splitting across consecutive groups if it still does not fit, so the
layers "may land in separate groups rather than all at once".

So the design composes. Two things still bite:

- **Availability here is unverified**, and verifying it would mean enabling a
  merge queue on `reddb-io/red-skills`, which the issue puts out of scope.
  Adopting before the rollout reaches us is precisely the "one jam for another"
  trade the issue warns against.
- **Auto-merge is documented as not yet available for stack merges** ("rule
  bypass and auto-merge functionality are coming soon but currently
  unavailable"). This is concrete for us, not hypothetical:
  `apps/dev/src/core/merge.ts:1530-1531` builds
  `gh pr merge <n> --merge` and appends `--auto` when a merge queue is
  configured. On a queue-enabled repository, our exact landing command is the
  one operation stacks currently do not support.

One decision nobody has taken is hiding here: we land by squash today. A
queue-merged stack lands under the queue's chosen method, per layer. That is a
change to the shape of `main`'s history, and it should be decided deliberately
rather than inherited from an adoption.

## 6. Preview risk

**Verified limitations:** public preview and "subject to change"; all branches
must live in the same repository, no cross-fork stacks; not supported in GitHub
Desktop; every layer is evaluated against the *stack's base* for required
reviews, status checks and CODEOWNERS, and a layer additionally needs approval
of every layer beneath it and fully linear history.

Stated plainly: adopting now would add a preview-stage GitHub feature, a new
host-level CLI extension with its own lock and recovery states, and a
force-push-and-recheck amplification, on top of a workflow that already carries
live defects — in exchange for a faster review/merge tail, while leaving the
`req:N` rule that motivated the spike exactly where it was.

Waiting costs us nothing that we cannot recover another way, because the
dispatch-gate change in the Recommendation is ours to make today.

## What was not done

Per the issue's constraints: the extension was not installed, no stacked pull
request was opened against `reddb-io/red-skills`, no workflow, skill or
convention was changed, and the merge queue was not treated as in scope.
