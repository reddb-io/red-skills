---
name: write-a-skill
description: Create new agent skills with proper structure, progressive disclosure, and bundled resources. Use when user wants to create, write, or build a new skill.
---

# Writing Skills

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

In-repo exemplars: `/start` (grill and sharpen the plan) hands off to `/to-prd`
(publish the PRD) instead of doing both, so the grilling isn't cut short by the
pull toward shipping; and `writing-fragments` is separate from `writing-shape` /
`writing-beats` so the raw-material gather isn't rushed toward the finished piece.

## SKILL.md writing style

Section structure (`<what-to-do>` / `<supporting-info>`) decides *where* a
sentence goes; this section decides *how the sentence reads*. Apply these nine
sentence-level techniques — borrowed from `anthropics/launch-your-agent` — when
writing any RedSkills SKILL.md. Each carries a one-line before → after.

1. **Bold lead-in + gloss** — open a step with the imperative in bold, then
   explain it.
   - Before: `You should gather the requirements from the user first.`
   - After: `**Gather requirements** — ask the user what task the skill covers.`

2. **Maxim/slogan compression** — fold a rule into one memorable line.
   - Before: `The description matters because it is what the agent uses to decide whether to load the skill.`
   - After: `The description is the only thing the agent sees before loading — write it for the picker, not the reader.`

3. **Prohibition + reason inline (em-dash consequence)** — state the ban and its
   cost on one line.
   - Before: `Do not exceed 100 lines. Long skills are hard to read.`
   - After: `Never exceed ~100 lines — past that the agent skims and drops steps.`

4. **Literal phrasing in quotes** — quote the exact words the agent must emit or
   match.
   - Before: `End the description with a phrase about when to use it.`
   - After: `End the description with "Use when …" so the trigger is matchable verbatim.`

5. **Vocabulary hygiene (real term, ban synonym)** — name a thing once, forbid
   its synonyms.
   - Before: `Put your docs / guidance / instructions in the file.`
   - After: `Call it the SKILL.md — never "the doc", "the manifest", or "the guide".`

6. **Numbered taxonomy when concepts blur** — number a set whose members are
   easily conflated.
   - Before: `Add scripts for deterministic work and split files for big skills.`
   - After: `Two distinct moves: (1) add a script for deterministic work; (2) split a file once SKILL.md passes ~100 lines.`

7. **Self-demonstrating voice** — write the instruction in the style it teaches.
   - Before: `Instructions should be concise and imperative.`
   - After: `Write every step imperative and bold-led — like this one.`

8. **Phase/step header carries its precondition** — fold the precondition into
   the header instead of a trailing aside.
   - Before: `## Review` followed by `(Only do this after the draft is complete.)`
   - After: `## Review (after the draft compiles and runs)`

9. **Leading words (prior-triggering domain terms)** — compress the core behavior
   into one consistent term, repeat that exact term throughout the skill, and
   confirm it took by watching for it in the agent's reasoning traces.
   - Before: `Build a thin end-to-end path through every layer first, then flesh out.`
   - After: `Ship a **tracer bullet** first — and say "tracer bullet" every time you mean it.`

## Steering failure modes

**Negation** — a skill that steers by prohibition drags the forbidden behaviour into context and makes it more available. "Don't invent files" activates file-invention before the model reads past it. The cure: replace every prohibition with a positive directive. Where a hard ban is unavoidable, pair it on the same line with the correct alternative — `emit DONE` not `don't write done`.

**Negative Space** — every case a skill leaves silent is delegated to the model's priors, not held neutral. Silences are not free: the model fills them from training, and training may not match the author's intent. The cure: read a draft for its silences and decide each omission deliberately. Fill it with the intended behaviour, or mark it as an acknowledged open branch. "Unaddressed" is not a valid final state.

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
