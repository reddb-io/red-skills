---
name: ship
description: DEPRECATED (ADR 0081). Use `/dev:requeue #ISSUE --adopt-branch BRANCH --guidance 'reason'` to adopt a hand-done branch through the gate. Dead alias, not model-reachable.
disable-model-invocation: true
---

# /ship — DEPRECATED (ADR 0081)

**`/ship` is retired. Use `/dev:requeue` instead.**

## What to use instead

- **Adopt a hand-done branch through the gate** → `/dev:requeue #ISSUE --adopt-branch BRANCH --guidance 'reason'`.
- **Dispatch an ad-hoc one-off demand** → `/dev:go "<demand>"`.

## Backwards-compat alias

Running `dev ship` still redirects to requeue during rollout — it prints this
notice, infers the issue from the current branch, and delegates to
`requeue #N --adopt-branch CURRENT_BRANCH`. Call `/dev:requeue` directly.
