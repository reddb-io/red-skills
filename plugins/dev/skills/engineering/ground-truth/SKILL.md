---
name: ground-truth
description: Adversarial self-verification discipline — never report a state-changing action as successful until you have re-derived the claim from a fresh ground-truth snapshot. The browser vehicle drives a11y-tree snapshots with numbered refs, stale-ref validation, and token-efficient TOON output (chrome-devtools-axi). Use as the verification ground-truth inside /verify, /code-review, the frontend skills, or any adversarial pass — anti-hallucination for verification.
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

For browser-driven verification, the concrete vehicle is **chrome-devtools-axi**: combined navigate+capture+suggest ops, a11y-tree snapshots with numbered refs, built-in stale-ref validation, a persistent bridge, and TOON output (~57% fewer tokens than raw chrome-devtools-mcp). See `<supporting-info>`.

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

## The browser vehicle — chrome-devtools-axi

`chrome-devtools-axi` is a token-efficient wrapper over `chrome-devtools-mcp` purpose-built for the loop above. It exists so a browser ground-truth read is cheap enough to take *every* time you make a claim, instead of being skipped for cost.

What it gives the loop:

- **a11y-tree snapshots with numbered refs.** Each interactive node is listed once with a stable `ref` and its accessible role + name — the snapshot *is* the ground-truth observable, in a fraction of a screenshot's tokens.
- **Stale-ref validation, built in.** Refs carry the snapshot they came from; using a ref after a state change forces a re-snapshot instead of silently acting on a moved target. This is step 3's guard, enforced by the tool.
- **Combined navigate + capture + suggest ops.** One call navigates, captures the fresh a11y tree, and suggests the next refs — collapsing "act, then re-read ground truth" into a single round-trip so the fresh read is never skipped.
- **Persistent bridge.** A long-lived browser session keeps cookies/auth/route state across calls, so a post-action snapshot reflects the *same* session the action ran in — not a cold reload that loses the state you are trying to verify.
- **TOON output.** Snapshots serialize as TOON (Token-Oriented Object Notation), ~57% fewer tokens than raw chrome-devtools-mcp JSON — the cost reduction that makes "snapshot before every claim" affordable.

Typical loop with the vehicle: take a baseline a11y snapshot → perform the state-changing action (click `ref=N`, submit, navigate) → **take a fresh snapshot** → confirm the claimed observable (node appeared/disappeared/changed) against that fresh snapshot, re-resolving any ref by role+name. Report success only with the fresh snapshot as the citation.

## Generalizing the loop beyond the browser

The browser is one ground truth; the discipline is identical for any state change. Pick the cheapest fresh read that proves the observable:

| State change | Fresh ground-truth read (after the action) | Stale-ref analog |
| --- | --- | --- |
| UI action | new a11y-tree snapshot (TOON) | DOM ref from a prior snapshot |
| DB write | a fresh `SELECT` of the affected rows | a row id read before the write |
| File edit | re-read the file from disk | a line number from before the edit |
| API mutation | a follow-up `GET` of the resource | an entity returned by the mutation call |
| Code fix | re-run the failing test / repro | a stack frame from the old run |
| Review claim | re-read the actual code path / re-run behavior | a line cited from memory |

In every row the failure mode is the same: trusting the *action's own response* or a *pre-action reference* as if it were post-action ground truth. The loop refuses that substitution.

## Integration pointers

- `/verify` is a built-in verification skill; this skill supplies its **evidence standard** — the verdict must cite a fresh post-action ground-truth read of the named observable, and browser checks should prefer the chrome-devtools-axi a11y-tree/TOON path for cost.
- `/code-review` and adversarial verification passes inherit the **default-to-refuted** posture: a finding stands only when re-confirmed against a fresh read; an unverifiable finding is reported as unverified, not confirmed.
- The frontend skills (`/impeccable` and its sub-skills) should re-snapshot the a11y tree after a UI edit and confirm the targeted element/state actually changed before reporting the edit done.

</supporting-info>
