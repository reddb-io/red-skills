---
"@reddb-io/red-skills": patch
---

A Project control verb carries its arguments across the ACP wire

`drain {"target":2}` did nothing and said nothing was wrong. The client renders
every parameterised control call as `/<verb> {json}`, the daemon's verb matcher
demanded a BARE verb, so the call matched nothing, fell through to "execute this
prompt in a Worker", and came back as narration with no answer in it —
indistinguishable from a Worker that failed. The adapter had the mirror-image
rule: it only routed a control tool to the control method when the input was
empty, so any argument silently turned the call into prose.

- The matcher reads the verb AND its argument object, and the control methods
  take `target` and `runner` as typed params (shape checked, meaning never
  read). A width the caller asked for is stored on the control record and
  echoed back as `requested_target` / `requested_runner`, because an argument
  that vanishes silently is indistinguishable from one that was honoured.
- Restating the width is a new revision rather than `already-draining`.
- The adapter routes a control tool with arguments to the control method, and
  **refuses** an argument the control surface cannot express instead of
  degrading it to a prompt.
- Two pre-existing red assertions in `acp-control-plane.test.ts` are repointed:
  a status answer is a drain answer plus its projections, so the record is what
  must survive a daemon replacement.
- `acp-control-plane.ts` is back under its headroom target (697 lines, from 719
  on main) by moving the v1 control turn beside its v2 twin and the control
  binding beside the record it operates on.
