# Current Blocker State

Human gates are first-class issue-body state. Before claiming an issue, AFK checks for an active `## Current blocker` block:

```md
## Current blocker

<!-- red:blocker-state v1 -->
status: blocked
kind: decision
ref: #856
summary: Phase 2 measured no columnar read win.
next: Human must decide whether to stop, redesign, or continue anyway.
<!-- /red:blocker-state -->
```

If this block is present with `status: blocked`, AFK removes `ready-for-agent`, adds `ready-for-human` plus the typed blocker label, and waits for `/hitl`.

When an attempt escalates to a terminal human page, the runtime writes or replaces this block so `/hitl` can start from the current blocker instead of re-reading old envelopes. `/hitl` clears the block and moves the issue back to `ready-for-agent` when the next agent can continue.
