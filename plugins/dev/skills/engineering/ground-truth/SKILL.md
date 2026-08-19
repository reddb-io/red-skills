---
name: ground-truth
working-mode: interactive
description: Adversarial self-verification discipline — never report a state-changing action as successful until you re-derive the claim from a fresh red-browser ground-truth snapshot. Runs inside /verify, /code-review, and the frontend skills. Use when about to assert a form submit, write, navigation, fix, or review verdict succeeded.
---

# Ground Truth

**Re-derive the claim from a fresh snapshot before you report success — your own action's return value is not evidence that it worked.**

<what-to-do>

The absorbed idea is one loop, not browser automation. Browser automation is only the **vehicle**: the discipline is **claim → fresh ground-truth → confirm**. Run this loop whenever you are about to assert that a state-changing action succeeded — a form submit, a write, a navigation, a fix, a review verdict.

### The loop — claim → fresh ground-truth → confirm

1. **State the claim out loud, before checking it.** Name the specific observable that must be true if the action worked: *"the row count is now 5"*, *"the error banner is gone"*, *"the `#submit` button is disabled"*. A claim you cannot phrase as a checkable observable is a vibe — sharpen it or do not assert it.
2. **Re-derive the observable from a FRESH ground-truth read.** Capture state *after* the action, from the source of truth — a new a11y-tree snapshot, a fresh DB query, a re-read file, a re-run test, a new API GET. Never reuse the snapshot you took *before* the action, and never trust the action's own success/return value as the observable.
3. **Confirm or recant.** Compare the fresh observable to the claim. Match → report success, citing the fresh read. Mismatch → report the failure with both the claimed and the actual value. **Silence is not confirmation** — if you could not get a fresh read, say the claim is *unverified*, never *confirmed*.

### Stale-ref validation — the anti-hallucination guard

A reference (`ref=12`, a row id, a line number, a DOM handle) captured from an **earlier** snapshot may no longer point at what you think after a state change. Before you act on or assert about any ref, **validate it against the current snapshot**:

- The ref must still exist in the fresh snapshot, and still denote the same element/row/field.
- A state-changing action **invalidates every ref** from the prior snapshot — re-snapshot, then re-resolve refs by their stable identity (role + name, primary key), not by position.
- Acting on a stale ref and reporting the result is the classic verification hallucination: the action lands on the wrong target, the return code is `0`, and you "confirm" a success that never happened.

### Where to run this loop

- **Inside `/verify`** — make the fresh-snapshot read the evidence the verdict cites. "It works" is unverified until a post-action ground-truth read confirms the specific observable.
- **Inside `/code-review` and any adversarial pass** — a finding ("this branch is unreachable", "the guard rejects X") is a claim; confirm it against a fresh read of the actual code/behavior before reporting it, and default to refuted when you cannot.
- **Inside the frontend skills** (`/impeccable`, `/audit`, `/polish`, `/animate`) — after a UI edit, re-snapshot the a11y tree and confirm the intended element/state actually changed, rather than trusting that the edit "should" have worked.

For browser-driven verification, the concrete vehicle is **red-browser**: `red-browser snapshot` captures an a11y-tree snapshot with numbered refs plus the console and network activity, over a CDP endpoint — the fresh ground-truth read this loop demands. See `<supporting-info>`.

### Hard rules — apply across every claim

- ❌ Do **not** report a state-changing action as successful from its own return value / exit code alone
- ❌ Do **not** confirm a claim against the snapshot you took **before** the action
- ❌ Do **not** act on or cite a ref without validating it against the **current** snapshot
- ❌ Do **not** treat "no error" or "couldn't check" as confirmation — that is *unverified*, report it as such
- ✅ **Do** state the checkable observable before you read it, then cite the fresh read when you confirm
- ✅ **Do** re-snapshot after every state change and re-resolve refs by stable identity
- ✅ **Do** prefer the token-cheapest fresh ground-truth that still proves the observable (TOON a11y-tree over a screenshot, one scoped query over a full dump)

</what-to-do>

<supporting-info>

## The browser vehicle — red-browser

`red-browser` is the browser ground-truth vehicle for the loop above (aligned with the browser-bridge direction of PRD #907/#928). It exists so a browser ground-truth read is cheap enough to take *every* time you make a claim, instead of being skipped for cost.

What `red-browser snapshot` gives the loop:

- **a11y-tree snapshots with numbered refs.** Each node is tagged with a stable `ref` integer and its accessible role + name — the snapshot *is* the ground-truth observable, in a fraction of a screenshot's tokens.
- **A monotonic `snapshotId`.** Each snapshot carries an increasing id, so a higher id is unambiguously the newer read — the freshness signal step 2 depends on.
- **Console and network capture.** Alongside the a11y tree, each snapshot reports the `console` entries and `network` responses seen since the driver connected — the observables for "no console errors" or "the API call returned 200".
- **Stale-ref discipline.** A `ref` absent from the newest snapshot is stale; re-snapshot and re-resolve by stable identity (role + name) before asserting. This is step 3's guard.

Typical loop with the vehicle: take a baseline a11y snapshot → perform the state-changing action (click `ref=N`, submit, navigate) → **take a fresh snapshot** → confirm the claimed observable (node appeared/disappeared/changed) against that fresh snapshot, re-resolving any ref by role+name. Report success only with the fresh snapshot as the citation. `/verify` documents the concrete `red-browser snapshot` command and its output schema.

## Generalizing the loop beyond the browser

The browser is one ground truth; the discipline is identical for any state change. Pick the cheapest fresh read that proves the observable:

| State change | Fresh ground-truth read (after the action) | Stale-ref analog |
| --- | --- | --- |
| UI action | new red-browser a11y-tree snapshot | DOM ref from a prior snapshot |
| DB write | a fresh `SELECT` of the affected rows | a row id read before the write |
| File edit | re-read the file from disk | a line number from before the edit |
| API mutation | a follow-up `GET` of the resource | an entity returned by the mutation call |
| Code fix | re-run the failing test / repro | a stack frame from the old run |
| Review claim | re-read the actual code path / re-run behavior | a line cited from memory |

In every row the failure mode is the same: trusting the *action's own response* or a *pre-action reference* as if it were post-action ground truth. The loop refuses that substitution.

## Integration pointers

- `/verify` is a built-in verification skill; this skill supplies its **evidence standard** — the verdict must cite a fresh post-action ground-truth read of the named observable, and browser checks should prefer the red-browser a11y-tree snapshot path for cost.
- `/code-review` and adversarial verification passes inherit the **default-to-refuted** posture: a finding stands only when re-confirmed against a fresh read; an unverifiable finding is reported as unverified, not confirmed.
- The frontend skills (`/impeccable` and its sub-skills) should re-snapshot the a11y tree after a UI edit and confirm the targeted element/state actually changed before reporting the edit done.

</supporting-info>
