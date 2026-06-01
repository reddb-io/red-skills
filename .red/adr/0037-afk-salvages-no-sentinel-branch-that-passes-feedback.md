---
status: accepted
---

# AFK salvages a no-sentinel branch that is ahead of base if it passes the feedback gate

When an AFK attempt ends without a `<promise>` sentinel (the ADR 0028 crash
signal) but its worker branch is **ahead of base** — i.e. a prior attempt
already committed complete work and the agent crashed before re-emitting the
sentinel — AFK now SALVAGES the attempt: it runs the feedback gate (typecheck +
tests) and, if green, LANDS the branch exactly like the DONE path. This is a
deliberate, feedback-gated deviation from ADR 0028 ("the `<promise>` sentinel is
the canonical attempt-exit signal"), fixing #332 where a branch carrying valid
work was abandoned to `blocked:crashed` and the loop never converged.

The sentinel stays canonical for the **no-work** case: a sentinel-less exit on a
branch that is *not* ahead of base is still terminal `no-sentinel` (a true
crash, nothing to salvage). The feedback gate is the load-bearing safety — it is
the only thing that distinguishes "complete prior work" from a half-baked
crash-edit, so a no-sentinel branch is NEVER landed without passing it. A salvage
attempt that fails feedback is reported as `feedback-failed`, not merged.

## Consequences

- The agent contract (`AGENT-PROMPT.md`) is the other half of this
  defense-in-depth: an agent that finds the work already complete MUST still
  emit `<promise>DONE</promise>` — the runtime salvage is the backstop for when
  it crashes before doing so.
- A salvaged-and-landed attempt is reported with `outcome: "done"` (it was
  merged), keeping the close path and envelope contract coherent.
