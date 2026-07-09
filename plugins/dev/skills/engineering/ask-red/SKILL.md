---
name: ask-red
description: Ask which RedSkills flow fits the current situation. Use when the operator asks what to do now, which command to run, or how to route a task through RedSkills.
disable-model-invocation: true
---

# Ask Red

You do not need to remember every RedSkills command. Ask the router.

A **flow** is a path through skills, not a single command. RedSkills has one
default lane, one exception lane, and several on-ramps that feed those lanes.

<what-to-do>

## 1. Classify The Situation

**Tracked work defaults to `/afk`.** If the work is already a Ticket, should be a
Ticket, or belongs to a Spec, route it through `/afk`. This is the modus
operandi.

**Ad-hoc work goes to `/go`.** Use `/go` only for a concrete one-off demand that
does not already belong on the tracker. If the work is already tracked, keep it
in `/afk`; if it is parked, use `/requeue` or `/hitl`.

**Ideas become Specs before execution.** For a fuzzy idea that fits in one
conversation, run `/start`, then `/to-spec`, then `/to-tickets`, then `/afk`.
For a huge or foggy effort, start with `/wayfinder`; its children later route
back into `/start`, `/to-spec`, `/to-tickets`, `/afk`, or `/hitl`.

## 2. Route By On-Ramp

- **Incoming bugs or requests** -> `/triage`, then `/afk` once Tickets become
  ready for agents.
- **A bug you can reproduce or diagnose now** -> `/diagnose`; if the user is
  only reporting a bug for later, use `/report-bug`.
- **A parked human decision** -> `/hitl`; if the blocker is resolved and the
  Ticket only needs queue promotion, use `/requeue`.
- **A manual implementation slice** -> `/implement`, using `/tdd` for the build
  loop and `/code-review` before handing the branch to `/requeue`.
- **Validation or visible confirmation** -> `/verify`; for browser-visible state,
  pair it with `/ground-truth`.
- **Operations state** -> `/dashboard`, `/daily-review`, `/audit-skills`, or
  `/context` depending on whether the question is queue health, period review,
  skill quality, or repository context.
- **Design uncertainty** -> `/prototype`; if the uncertainty is too broad for
  one throwaway answer, use `/wayfinder`.

## 3. Answer With The Route

Return the smallest useful flow, in order. Name the first command to run and the
handoff condition for the next command.

Use this form:

```text
Route: /first -> /second -> /final
Start with: /first
Why: <one sentence>
Next handoff: <what must be true before the next command>
```

</what-to-do>

<supporting-info>

## Coverage Inventory

The router must mention every published dev skill so `/doctor` can flag drift:
`/afk`, `/ask-red`, `/go`, `/wayfinder`, `/model-tier-policy`, `/curate`,
`/context`, `/daily-review`, `/dashboard`, `/audit-skills`, `/diagnose`,
`/ground-truth`, `/doctor`, `/review-adrs`, `/ship`, `/start`, `/triage`,
`/hitl`, `/report-bug`, `/retake`, `/requeue`, `/urgent`,
`/improve-codebase-architecture`, `/setup-red-skills`, `/setup-statusline`,
`/implement`, `/tdd`, `/to-tickets`, `/to-spec`, `/zoom-out`, `/prototype`,
`/verify`, `/review`, `/code-review`, `/resolving-merge-conflicts`,
`/branch-lock`, `/git-guardrails-claude-code`, `/migrate-to-shoehorn`,
`/setup-pre-commit`, `/wiki-init`, `/wiki`, `/research`, `/ff`, `/reflect`,
`/handoff`, `/write-a-skill`.

## Standalone And Maintenance Routes

- `/doctor` checks RedSkills adoption drift, including whether this router still
  covers the registered skill set.
- `/setup-red-skills` and `/setup-statusline` are setup/adoption routes, not
  feature-work routes.
- `/urgent` creates an urgent tracked Ticket, then the work still flows through
  `/afk`.
- `/retake` reconstructs state for one Ticket before choosing `/afk`, `/hitl`,
  or `/requeue`.
- `/review-adrs` audits the decision record and usually feeds `/to-spec`.
- `/model-tier-policy` answers runner/model tier choices.
- `/zoom-out`, `/research`, `/wiki`, `/wiki-init`, `/handoff`, `/ff`, and
  `/reflect` are understanding or productivity routes that feed the main flow.
- `/branch-lock`, `/git-guardrails-claude-code`, `/migrate-to-shoehorn`, and
  `/setup-pre-commit` are targeted utility routes.
- `/ship` is retained for compatibility only; live hand-worked landing routes
  through `/requeue`.
- `/review` is for HTML artifact annotation review; `/code-review` is for code
  diff review.
- `/curate` is the interactive skill archive route.

</supporting-info>
