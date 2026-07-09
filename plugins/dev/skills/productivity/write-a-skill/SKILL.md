---
name: write-a-skill
description: Create new agent skills with proper structure, progressive disclosure, and bundled resources. Use when user wants to create, write, or build a new skill.
---

# Writing Skills

<what-to-do>

## Process

1. **Gather requirements** — ask the user, before drafting anything:
   - What task or domain does the skill cover?
   - Which specific use cases must it handle?
   - Does it need executable scripts, or just instructions?
   - Any reference material to bundle?

2. **Draft the skill** — produce:
   - A SKILL.md with concise, imperative instructions.
   - Extra reference files only when content would push SKILL.md past ~100 lines.
   - Utility scripts only when a deterministic operation repeats.

3. **Review with the user** — present the draft and ask whether it covers the
   use cases, what is missing or unclear, and which section needs more or less
   detail. Do not ship before this loop closes.

</what-to-do>

<supporting-info>

## Skill structure

```
skill-name/
├── SKILL.md           # Main instructions (required)
├── REFERENCE.md       # Detailed docs (only if needed)
├── EXAMPLES.md        # Usage examples (only if needed)
└── scripts/           # Utility scripts (only if needed)
    └── helper.js
```

## SKILL.md template

```md
---
name: skill-name
description: Brief description of capability. Use when [specific triggers].
---

# Skill Name

<what-to-do>

[The primary directive — imperative, non-negotiable steps the agent
executes literally. DOs / DON'Ts here are hard constraints.]

</what-to-do>

<supporting-info>

[Reference material consulted on demand — formats, file layouts, trigger
conditions, examples. Link one level deep: see [REFERENCE.md](REFERENCE.md).]

</supporting-info>
```

## Description requirements

The description is **the only thing the agent sees before loading the skill** —
write it for the picker, not the reader. It is surfaced in the system prompt
beside every other installed skill, and the agent chooses from those lines
alone.

Give the agent just enough to know two things: what the capability is, and
when to trigger it (keywords, contexts, file types).

**Format**:

- Max 1024 chars.
- Third person.
- First sentence: what it does.
- Second sentence: starts with the literal `"Use when"` so the trigger is
  matchable verbatim.

**Good** — distinguishes itself from every other document skill:

```
Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when user mentions PDFs, forms, or document extraction.
```

**Bad** — gives the agent no way to pick it:

```
Helps with documents.
```

## Trigger decision (user-invoked vs model-invoked)

Decide **before writing the description**: should the model reach for this skill
on its own, or only the operator by typing `/skill-name`? Set
`disable-model-invocation: true` in the frontmatter to make a skill **user-only**
— the model can no longer trigger it; it runs solely on the explicit command.

The trade-off is where the load lands. A **model-invocable** skill's description
is loaded into every session's context — a standing **context load on the agent**,
paid on every turn whether or not the skill fires. A **user-only** skill imposes
**cognitive load on the operator** instead — they must remember the command
exists — but costs the agent zero standing context.

**Default rule: deliberate operational commands ship user-only.** Setup wizards,
reports, and dispatch/maintenance verbs are things the operator decides to run —
`disable-model-invocation: true`. Skills the model should proactively reach for
stay model-invocable, and then **the description must earn its context cost** —
every session pays for it, so it has to distinguish itself from every other line.

User-only also removes a **class of problem**: model invocation is unpredictable.
Even a well-scoped description may not fire when it fits — the model can skip a
context pointer it should have followed. A `/command` the operator types can't be
missed that way, so deliberate commands become reliable by construction.

## When to add scripts

Add a utility script when the operation is deterministic (validation,
formatting), when the same code would be generated repeatedly, or when errors
need explicit handling. Scripts save tokens and beat generated code on
reliability.

## When to split files

Split into a separate file when SKILL.md exceeds ~100 lines, when content spans
distinct domains (finance vs sales schemas), or when advanced features are
rarely needed — keep references one level deep so the agent never chases a chain.

**Branch-gated external references** — reference material consumed by only one
branch (mode / flag / subcommand) of the skill moves to a sibling file behind a
one-line context pointer: `if X, read Y`. The unused branch then costs the agent
nothing until it fires. In-repo exemplars: `afk`'s Actions-lane reference
(`actions-lane.md`, read only on the GitHub-Actions branch), `tdd`'s bundled
reference files (`mocking.md`, `refactoring.md`, …, each pulled in only when that
sub-topic comes up), and `prototype`'s two branch files (`LOGIC.md` vs `UI.md`,
one per route the skill takes).

## Leg-work splitting (hide the goal to protect the gather phase)

When an early gather/interview phase keeps getting **rushed because the final
artifact goal is visible in the same skill**, split the phase into its own skill
so the future step is hidden. With the payoff out of sight, the agent can't skip
ahead to it — the gather phase runs to completion on its own terms.

In-repo exemplars: `/start` (grill and sharpen the plan) hands off to `/to-spec`
(publish the Spec) instead of doing both, so the grilling isn't cut short by the
pull toward shipping; and `writing-fragments` is separate from `writing-shape` /
`writing-beats` so the raw-material gather isn't rushed toward the finished piece.

## SKILL.md writing style

Section structure (`<what-to-do>` / `<supporting-info>`) decides *where* a
sentence goes. Sentence-level style and Steering failure modes live in
[WRITING-STYLE.md](WRITING-STYLE.md); read it before drafting or reviewing any
RedSkills SKILL.md.

## Review checklist (run after the draft compiles)

- [ ] Description ends with the literal `"Use when …"` trigger.
- [ ] SKILL.md stays under ~100 lines (excluding this meta-skill).
- [ ] No time-sensitive info.
- [ ] One term per concept — no synonym drift.
- [ ] Concrete before → after or input → output examples included.
- [ ] References stay one level deep.
- [ ] Steps read imperative and bold-led — the skill follows its own style.
- [ ] **Deletion test** — for each paragraph, ask "would the agent behave
  differently if this were deleted?" Delete the no-ops.
- [ ] **Trigger decision recorded** — the skill is explicitly user-only
  (`disable-model-invocation: true`) or model-invocable with a description that
  earns its context cost.
- [ ] **Negation check** — each prohibition has a paired positive alternative on
  the same line; rewrite standalone "don't X" entries as "do Y instead".
- [ ] **Negative-space audit** — each silence is a deliberate open branch, not an
  oversight; fill gaps or name them explicitly.

</supporting-info>
