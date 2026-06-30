---
name: ship
description: DEPRECATED (ADR 0081). Use `/dev:requeue #ISSUE --adopt-branch BRANCH --guidance 'reason'` to adopt a hand-done branch through the no-agent gate. This skill is a backwards-compat alias that redirects to requeue.
argument-hint: "[--issue N] [--base BRANCH]"
---

# /ship — DEPRECATED

**`/ship` is retired (ADR 0081). Use `/dev:requeue` with `--adopt-branch` instead.**

## What to use instead

When you have done work by hand on an existing branch and want to run it through
the gate and land it:

```bash
red-skills-dev requeue #ISSUE --adopt-branch BRANCH --guidance 'reason for adoption'
```

This routes the branch through the **no-agent landing lane** (ADR 0055 reconcile):
gate-only validation (no agent re-run), then lands via the shared `doLanding` path.

## Why /ship was retired

`/ship` was an orphan command with a fuzzy trigger ("I never know when to call it").
ADR 0081 dissolved it into requeue so the manual path and the AFK path share the
same gate and landing logic — one code path, one authority.

## Backwards-compat alias

Running `dev ship` still works during rollout: it prints the deprecation notice,
infers the issue number from the current branch, and delegates to
`requeue #N --adopt-branch CURRENT_BRANCH --guidance '...'` automatically.
Update your workflow to call requeue directly.

## See also

- `/dev:requeue` — the replacement for manual branch adoption
- `/dev:hitl` — when a human decision still needs to be extracted before requeueing
- ADR 0081 — command topology decision (goal / go / afk; ship retired)
