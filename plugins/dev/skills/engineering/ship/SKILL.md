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

## The ship pipeline (seven ordered stages)

The validation the `/ship` concept always stood for now runs inside the shared
gate that `/dev:requeue` and `/afk` both invoke. It is an **ordered pipeline** —
each stage must pass before the next runs, and a failure at stage N stops the
pipeline at N and reports the stage name and reason (no later stage runs):

1. **Review** — scan the diff for obvious issues
2. **Test** — run the full test suite
3. **Docs** — verify public API or SKILL.md changes are documented
4. **Lint** — run the linter / typecheck
5. **Push** — push the branch to the remote
6. **PR** — open or reuse the PR
7. **CI** — wait for CI to pass

The pipeline order is fixed in `SHIP_PIPELINE_STAGES` (`apps/dev/src/core/ship.ts`)
and evaluated by `runShipPipeline`, which returns the first failing stage.

## Mechanical vs intentional fix split

Before applying any fix the pipeline proposes, it is **labelled** one of two
classes (mapping to the existing INFRA/SEMANTIC distinction):

- **Mechanical** — auto-applied silently. A fix is mechanical only when it cannot
  change behaviour: formatting, import sort, unused variable, trailing
  whitespace.
- **Intentional** — escalated to the user (park `ready-for-human` or prompt
  interactively) and **never** silently applied. A fix is intentional when it
  changes a public symbol, contract, or observable behaviour.

A fix that cannot be classified as mechanical **with confidence is treated as
intentional** — the safe default. The classifier is `classifyFix` and the
per-fix action is `decideFixApplication` (`apps/dev/src/core/ship.ts`).

## See also

- `/dev:requeue` — the replacement for manual branch adoption
- `/dev:hitl` — when a human decision still needs to be extracted before requeueing
- ADR 0081 — command topology decision (goal / go / afk; ship retired)
