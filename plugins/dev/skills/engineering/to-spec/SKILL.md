---
name: to-spec
description: Turn the current conversation context into a Spec and publish it to the project issue tracker. Use when user wants to create a Spec from the current context.
argument-hint: "[--tags a,b]"
---

**Synthesize the current conversation into a Spec and publish it — no interview, no implementation.** Just synthesize what you already know from the conversation.

The issue tracker and triage label vocabulary should have been provided to you — run `/red-setup` if not.

<what-to-do>

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the Spec, and respect any ADRs in the area you're touching.

2. Sketch out the testing seams for the feature. Prefer existing, high-level seams over new low-level ones. If new seams are needed, propose them at the highest point that can exercise the behavior.

Check with the user that these seams match their expectations. **Read [`/start`'s INTERVIEW-ROUNDS.md](../start/INTERVIEW-ROUNDS.md) and follow its question format for this check and for every other question this skill asks** — the seam proposal is the evidence above the round; the ask itself is a `❓ **Q##**` block with `➡️` marking your recommendation.

**Capture every HITL call** made during the conversation that led to this Spec — testing seam choices, module shape choices, trade-offs the user took a side on, alternatives they rejected, constraints they imposed. These go into the `Human Decisions` section of the template. Do not silently fold them into `Implementation Decisions` — once `/to-tickets` slices this Spec and `/afk` picks up the children, the human's calls become indistinguishable from agent inference unless they are flagged here.

3. **Cascade gate — run before publishing.** AFK workers branch from `origin/{base}` and cannot see the primary checkout's working-tree edits, so never publish while docs are unlanded.

   a. `git fetch origin`, then compare the `.red/` docs (`.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`, `.red/adr/**`) between the primary working tree and `origin/{base}` (base resolved lock > pin > main). "Landed" means reachable from `origin/{base}`, not merely present on disk — origin-first comparison, mirroring the `/adr-editor` convention.
   b. **On mismatch:** run the doc-landing procedure from the `/start` end-of-session finalizer (canonized by ADR 0092) first, then continue to step 4.
   c. **If landing is impossible** (no network, no push access): abort — never publish while docs are unlanded. State clearly which files must be landed and stop.

4. Write the Spec using the template below, then publish it to the project issue tracker.

   **Labels on publish:** apply `type:spec` and `needs-slicing`. With `--tags a,b` (or tags recorded during the `/start` grilling session), also apply the territory `tag:<value>` labels — create each missing one first with `gh label create "tag:<v>"` (on-demand creation, same pattern as `req:N`); `/to-tickets` propagates them to every child Ticket. **Do not apply `ready-for-agent` to a Spec — a Spec is not an implementable unit; `/to-tickets` must slice it first.** `/afk` hard-filters anything tagged `type:spec` so an accidental `ready-for-agent` will be ignored, but the right pre-condition is to not set it in the first place.

   The next step after publish is `/to-tickets` (manual or scheduled) which consumes `needs-slicing` Specs, generates child issues with `spec:{N}` + `ready-for-agent`, and removes `needs-slicing` from the parent.

</what-to-do>

<supporting-info>

<spec-template>

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

Calls the human made during the conversation that produced this Spec. These are load-bearing — they reflect judgement that the agent could not have inferred on its own and must survive into the slicing + implementation phases. One bullet per decision, in this shape:

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
- Which seams or modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Acceptance Criteria

machine-checkable criteria that downstream `/to-tickets` children can inherit or specialize. Every item must name a verifiable artifact: a test, command, fixture, or pinned observable behavior.

- [ ] Running `<focused command>` passes for the shipped behavior.
- [ ] The failing fixture or reproduction demonstrates the behavior before the implementation.
- [ ] The pinned observable behavior remains true after re-running the command or workflow.

## Out of Scope

A description of the things that are out of scope for this Spec.

## Further Notes

Any further notes about the feature.

</spec-template>

</supporting-info>
