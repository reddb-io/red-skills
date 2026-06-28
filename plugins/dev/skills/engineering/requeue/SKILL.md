---
name: requeue
description: Safely requeue a parked `blocked:validation` or `blocked:spec` issue after a human decision is already made. Clears the active `## Current blocker`, drops stale `ready-for-human`/`blocked:*` labels, and applies `ready-for-agent` as one coherent transition so AFK preflight does not re-park it. Refuses mixed `blocked:*` states and label/body mismatches — use `/hitl` for those.
argument-hint: "#ISSUE --guidance \"text\" [--repo OWNER/REPO] [--dry-run] [--json]"
---

# /requeue

**Put a parked `blocked:validation`/`blocked:spec` issue back in the queue as ONE transition — clear the blocker, record the guidance, flip the labels atomically. A label flip alone is a silent no-op loop.**

## Why a label flip alone fails

A validation or spec failure parks an issue with `ready-for-human`, a `blocked:*` label, and an active `## Current blocker` block in the body. AFK preflight reads that active non-mechanical blocker and **re-parks the issue before any work starts** — so flipping labels back to `ready-for-agent` by hand produces a silent no-op retry loop: the queue shows the issue as queued, but preflight immediately stops it. The blocker must be cleared in the SAME transition that flips the labels (see #850 for the incident evidence).

## Run

```bash
red-skills-dev requeue 123 --guidance "Retry with the documented guidance; the gate flake is fixed."
```

`--guidance` is required — it is the Human guidance recorded in an auditable `directive` comment before the transition is applied. The runtime accepts both `123` and `#123`; quote `'#123'` through a shell. Use `--dry-run` to print the planned transition without mutating, and `--json` for structured output.

## Behaviour

1. Require `--guidance`; exit 2 immediately if it is missing or empty.
2. Read the issue body, labels, and state. Refuse (exit 1) a non-OPEN issue.
3. Refuse without mutation (exit 1, direct to `/hitl`) when:
   - the issue carries **mixed `blocked:*` labels** (e.g., both `blocked:validation` and `blocked:spec`);
   - the `blocked:*` label kind does not match the active `## Current blocker` kind in the body (**label/body mismatch**);
   - the blocked kind is not `validation` or `spec` (e.g., `blocked:decision`, `blocked:stalled`).
4. Refuse (no-op exit 0) any issue that is not parked — no active `## Current blocker`, no `blocked:*` label, no `ready-for-human`.
5. Otherwise apply the requeue transition atomically:
   - clear/archive the active `## Current blocker` into `## Resolved blockers`;
   - post a `directive` comment recording the human `--guidance`;
   - remove `ready-for-human` and every `blocked:*` label, and add `ready-for-agent`.

## `/requeue` vs `/hitl` — the decision boundary

**Use `/requeue`** when:
- The issue is `blocked:validation` or `blocked:spec` (no other `blocked:*` label).
- The label kind and the active `## Current blocker` kind in the body agree.
- You already have the retry guidance and do not need an interview to extract it.

**Use `/hitl`** when:
- The pending human decision still has to be **extracted and answered** — `/hitl` interviews you for the answer, decides whether the issue is delegable, then (when delegable) clears the blocker and requeues.
- The issue carries **mixed `blocked:*` labels** or a **label/body mismatch** — `/hitl` reconciles ambiguous blocker state before applying any transition.
- The blocked kind is anything other than `validation` or `spec` (e.g., `blocked:decision`, `blocked:stalled`) — those require the full `/hitl` interview.

Both commands end in the same safe state — an issue in `ready-for-agent` with no active non-mechanical blocker. `/requeue` is the focused shortcut for the already-decided case; `/hitl` is the general path for everything else.
