---
name: to-prd
description: Turn the current conversation context into a PRD and publish it to the project issue tracker. Use when user wants to create a PRD from the current context.
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user — just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you — run `/setup-red-skills` if not.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch out the major modules you will need to build or modify to complete the implementation. Actively look for opportunities to extract deep modules that can be tested in isolation.

A deep module (as opposed to a shallow module) is one which encapsulates a lot of functionality in a simple, testable interface which rarely changes.

Check with the user that these modules match their expectations. Check with the user which modules they want tests written for.

**Capture every HITL call** made during the conversation that led to this PRD — module shape choices, trade-offs the user took a side on, alternatives they rejected, constraints they imposed. These go into the `Human Decisions` section of the template. Do not silently fold them into `Implementation Decisions` — once `/to-issues` slices this PRD and `/afk` picks up the children, the human's calls become indistinguishable from agent inference unless they are flagged here.

3. Write the PRD using the template below, then publish it to the project issue tracker.

   **Labels on publish:** apply `type:prd` and `needs-slicing`. **Never apply `ready-for-agent` to a PRD** — PRDs are not implementable units, they must be split into slices by `/to-issues` first. `/afk` hard-filters anything tagged `type:prd` so an accidental `ready-for-agent` will be ignored, but the right pre-condition is to not set it in the first place.

   The next step after publish is `/to-issues` (manual or scheduled) which consumes `needs-slicing` PRDs, generates child issues with `prd:{N}` + `ready-for-agent`, and removes `needs-slicing` from the parent.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Human Decisions

Calls the human made during the conversation that produced this PRD. These are load-bearing — they reflect judgement that the agent could not have inferred on its own and must survive into the slicing + implementation phases. One bullet per decision, in this shape:

- **Decision:** what was decided
- **Why:** the reason the human gave
- **Alternatives considered:** options that were rejected and why (omit if not applicable)

If a decision is genuinely just agent inference, it does not belong here — put it in `Implementation Decisions` instead.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
