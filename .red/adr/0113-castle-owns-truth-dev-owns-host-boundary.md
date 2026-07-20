# 0113 — Castle owns the truth, dev owns the host boundary

- **Status**: accepted
- **Date**: 2026-07-20
- **Related**: ADR 0101 (red-castle as the AFK execution substrate), ADR 0102 (dev as the host-adapter surface; statusline as the flagship external consumer)

## Context

ADR 0101/0102 split the codebase into **red-castle** (the AFK execution substrate)
and **dev** (the host-adapter / skill surface), with a rough ownership list:
Worker / Ticket / Lane / PR → castle; Host / Skill / Statusline → dev. A list is
not a principle, and several modules do not resolve under it without a judgement
call (#2230, #2232): `trust-gate`, `worktree-pool`, `process-safety`,
`claim-staleness`, `watchdog`, `mirror`, `reconcile`, `boot-sweep`, `red-doctor`,
`triage`, and the hook bodies (`branch-lock`, `command-guard`, `rsp-hook`). ADR
0102 kept `statusline` in dev as "the flagship external consumer" — but a renderer
that re-derives execution state duplicates what castle already knows and grows
complex.

## Decision

The discriminating principle is **castle owns the truth; dev owns the host
boundary**. "Truth" is execution state, policy, and the feeds computed from them;
"host boundary" is everything that renders that truth to a human or enforces it
inside a specific agent host. A module that both computes truth and presents or
enforces it is **split along a seam, not assigned whole**. Two seams cover every
hybrid:

1. **Produce → castle / render → dev.** Castle produces every execution-state
   feed — worker vitals, fleet state, diagnostic data, straggler detection. Dev
   renders it — the statusline string, the `red-doctor` report, the `triage`
   display. The renderer stays thin because the insumo arrives ready to format.

2. **Policy → castle / mechanism → dev.** Castle owns the rule — the `trust-gate`
   policy of what may run, the lane rules. Dev owns the host-side enforcement
   mechanism — the `branch-lock` / `command-guard` / `rsp-hook` hook bodies that
   intercept commands in the host. The rule lives in one place; the hook stays
   thin and host-swappable.

### Module map (#2232)

| Owner | Kind | Modules |
| --- | --- | --- |
| **castle** | substrate | `worktree-pool`, `process-safety`, `claim-staleness`, `watchdog`, `mirror`, `reconcile`, `boot-sweep` |
| **castle** | policy | `trust-gate` rule, lane rules |
| **castle** | feed production | statusline insumo, `red-doctor` data, `triage` straggler detection |
| **dev** | render | statusline render, `red-doctor` report, `triage` display |
| **dev** | enforcement mechanism | `branch-lock`, `command-guard`, `rsp-hook` |

**Statusline resolves the ADR 0102 question by refinement, not reversal.** The
*render* stays dev's flagship external consumer; the *insumo* it renders moves to
castle, so the renderer no longer re-derives state.

## Consequences

- A new module is classified by one question: *is this truth (state / policy /
  feed) or host boundary (render / mechanism)?* Hybrids split; they are never
  forced whole onto one side.
- This principle is expected to resolve the sibling decisions #2237 (the
  adversarial-review state machine is castle truth that dev triggers) and
  #2250 / #2252 (the shared argument layer belongs where the arg *truth* lives),
  without re-litigating the seam.
- Relocating the split modules is follow-on implementation work, sliced
  separately; this ADR fixes *where each half belongs*, not the migration order.
- The split keeps every dev-side renderer and hook thin and host-swappable, which
  is the property that lets a second host (codex, opencode) reuse castle's truth
  without reimplementing it.
