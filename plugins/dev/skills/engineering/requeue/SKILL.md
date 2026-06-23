---
name: requeue
description: Safely requeue an issue parked behind an active `## Current blocker` after a human decision makes it delegable again. Clears the active blocker, drops stale `ready-for-human`/`blocked:*` labels, and applies `ready-for-agent` as one transition so AFK preflight does not immediately re-park it. Use when you already have the retry guidance and just need to put a `blocked:validation`/`blocked:spec` issue back in the queue.
argument-hint: "#ISSUE [--guidance \"text\"] [--repo OWNER/REPO] [--dry-run] [--json]"
---

# /requeue

**Put a parked issue back in the queue as ONE transition — clear the blocker, drop the stale labels, add `ready-for-agent`. A label flip alone is a no-op loop.**

## Why a label flip alone fails

A validation/spec failure parks an issue with `ready-for-human`, a `blocked:*` label, and an active `## Current blocker` block in the body. AFK preflight reads that active non-mechanical blocker and **re-parks the issue before any work starts**. So flipping labels back to `ready-for-agent` by hand creates a silent no-op retry loop: the queue shows the issue, preflight immediately stops it. The blocker must be cleared in the SAME transition that flips the labels.

## Run

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/engineering/afk/bin/afk.mjs" requeue 123 --guidance "Retry with the documented guidance; the gate flake is fixed."
```

The runtime accepts both `123` and `#123`; quote `'#123'` through a shell. Use `--dry-run` to print the planned transition without mutating, and `--json` for structured output.

## Behaviour

1. Read the issue body, labels, and state. A non-OPEN issue is refused.
2. Refuse (no-op exit 0) any issue that is not parked — no active `## Current blocker`, no `blocked:*` label, no `ready-for-human`.
3. Otherwise apply the requeue transition:
   - clear/archive the active `## Current blocker` into `## Resolved blockers` (never a manual body edit);
   - post a `directive` comment recording the human `--guidance`;
   - remove `ready-for-human` and every `blocked:*` label, and add `ready-for-agent`.

## `/requeue` versus `/hitl`

- **`/hitl`** — the interactive decision path. Use it when the pending human decision still has to be **extracted and answered**: it interviews you for the answer, decides whether the issue is delegable, then (when delegable) clears the blocker and requeues. Reach for `/hitl` when you are draining the `ready-for-human` queue and resolving decisions.
- **`/requeue`** — the focused requeue path. Use it when the decision is **already made** and you just need to put a `blocked:validation`/`blocked:spec` issue back in the queue safely with one command. It does not interview; it records the guidance you pass and applies the transition.

Both end in the same safe state — an issue in `ready-for-agent` with no active blocker. `/requeue` is the shortcut for when you do not need the `/hitl` interview.
