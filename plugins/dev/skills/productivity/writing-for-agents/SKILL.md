---
name: writing-for-agents
description: Designs and revises documents that agents read, including skills, always-loaded instructions, and disclosed references. Use when creating or editing a SKILL.md, AGENTS.md, CLAUDE.md, agent-facing instructions, or documentation reached through a context pointer.
---

# Writing for Agents

<what-to-do>

## Process

1. **Name the behaviour and reader** — state what the agent must do differently
   after reading and which agent-read surface owns that behaviour. For a skill,
   gather its task, use cases, executable needs, and reference material. For an
   `AGENTS.md` or `CLAUDE.md`, identify why the rule must load in every matching
   session instead of behind a context pointer.

2. **Set completion criteria** — bind the document and each procedural step to
   a checkable finish. Assess both **clarity** (can the agent distinguish done
   from not-done?) and **demand** (how much work the bound actually requires).
   Sharpen a fuzzy bound before splitting the sequence.

3. **Design the information hierarchy** — place each instruction at the lowest
   rung that still loads when needed: an in-file step, an in-file reference, or
   a disclosed reference. Co-locate material used by the same branch and write
   every context pointer around the condition that should activate it.

4. **Draft in agent-operable language** — make the positive target imperative,
   use one term per concept, and include concrete before → after or input →
   output examples. For a RedSkills `SKILL.md`, keep the
   `<what-to-do>`/`<supporting-info>` split and apply
   [WRITING-STYLE.md](WRITING-STYLE.md) at sentence level.

5. **Prune against sources of truth** — remove duplicated rules, environment
   caches, irrelevant detail, sediment, and paragraphs that fail the no-op test:
   “Would deleting this change the agent's behaviour?”

6. **Review with the user** — present the draft and ask whether it covers the
   intended cases, what is missing or unclear, and which section needs more or
   less detail. Finish only when the completion criteria and load placement are
   agreed.

</what-to-do>

<supporting-info>

## Core vocabulary

### Context pointer

A **context pointer** names material outside the current context and states the
condition for reaching it. Its wording is the routing decision: a perfect target
behind a vague condition stays unread, while a precise “if X, read Y” loads at
the moment it can change behaviour.

### The two loads

1. **Context load** — material loaded into the agent's context, paid whenever
   that context is assembled. `AGENTS.md` and `CLAUDE.md` rules are standing
   context load; a model-invocable skill description is a smaller standing load.
2. **Cognitive load** — what the human must remember, choose, or explicitly
   invoke. It is the price of human agency, not a number to minimise blindly:
   deliberate commands can belong with the operator even when automation could
   save a thought.

Move load deliberately. A context pointer trades standing context load for the
risk or cognitive load of reaching the disclosed material.

### Information hierarchy

Three rungs determine what sits beside what:

1. **In-file step** — hot-path action the agent executes in sequence.
2. **In-file reference** — definitions or examples kept beside the steps because
   several branches use them.
3. **Disclosed reference** — separate material reached through a context pointer
   only when its branch activates.

Progressive disclosure is the move down this ladder. Co-location is the inverse
question: material used together should load together, so splitting a sequence
that always travels as one merely adds a missed-pointer failure mode.

### Completion criteria

Every bound has two properties:

- **Clarity** — whether the agent can observe done versus not-done.
- **Demand** — how much the bound requires before done is true.

A fuzzy bound invites premature completion because later work pulls the agent
forward. Sharpen the bound first; split a phase only when its criterion remains
irreducibly fuzzy and the visible next phase keeps causing the rush.

### Leading words and Negation

**Leading words** are pretrained concepts the agent can think with, such as
“tracer bullet” or “frontier.” Repeat the compact token where it recruits the
same prior; repeat its explanation only at the single source of truth.

**Negation** is a steering failure mode: a prohibition activates the forbidden
behaviour in context. State the positive target. When a hard ban carries unique
safety value, pair it inline with the correct alternative. The sentence-level
patterns and before → after examples remain in
[WRITING-STYLE.md](WRITING-STYLE.md); they complement this information hierarchy
and do not replace it.

### Pruning

Prune with five tests:

1. **Single source of truth** — one rule owns the fact; every other site points.
2. **Environment as a source of truth** — treat the environment as a source of truth;
   a document that restates discoverable repository or tool state is a cache and
   needs a demonstrated reason to exist.
3. **Relevance** — keep material only when it can change behaviour on a branch
   this document owns.
4. **Sediment** — remove historical explanations, superseded workflow, and
   wording that survives only because nobody re-tested it.
5. **No-op test** — delete any paragraph whose removal would not change how the
   agent acts.

## Skill packaging

```text
skill-name/
├── SKILL.md           # Main instructions (required)
├── REFERENCE.md       # Detailed docs (only if needed)
├── EXAMPLES.md        # Usage examples (only if needed)
└── scripts/           # Utility scripts (only if needed)
    └── helper.js
```

### SKILL.md template

```md
---
name: skill-name
description: Brief description of capability. Use when [specific triggers].
---

# Skill Name

<what-to-do>

[The primary directive — imperative, non-negotiable steps the agent executes.]

</what-to-do>

<supporting-info>

[Reference material consulted on demand. Link one level deep: if X, read
[REFERENCE.md](REFERENCE.md).]

</supporting-info>
```

### Description requirements

The description is the context pointer the skill picker sees before loading —
write it for the picker, not the reader. Give the agent enough to know what the
capability is and when to trigger it, including keywords, contexts, and file
types that distinguish it from neighbouring skills.

- Maximum 1024 characters.
- Third person.
- First sentence states what it does.
- Second sentence starts with the literal `"Use when"` so the trigger is
  matchable verbatim.

Good — distinguishes itself from every other document skill:

```text
Extracts text and tables from PDFs, fills forms, and merges documents. Use when working with PDF files or document extraction.
```

Weak — gives the picker no usable condition:

```text
Helps with documents.
```

### Trigger decision: human-invoked or model-invoked

Decide before writing the description. Set `disable-model-invocation: true` to
make a skill human-invoked; leave it absent when the model should follow the
description's context pointer on its own.

Deliberate operational commands default to human-invoked. Setup wizards,
reports, and dispatch or maintenance verbs are operator decisions. Skills the
model should proactively reach stay model-invocable, and their descriptions
must earn the standing context load by distinguishing themselves from every
other line.

Human invocation also makes the load decision reliable: the operator supplies
the pointer explicitly. Model invocation depends on the agent recognizing that
the description's condition matches the current task.

### When to add scripts

Add a utility script when an operation is deterministic, the same code would be
generated repeatedly, or failures need explicit handling. Scripts save context
and make repeated operations reliable.

### When to split files

Split when `SKILL.md` exceeds roughly 100 lines, content spans distinct domains,
or advanced material serves a rare branch. Keep references one level deep so a
context pointer never starts a chain.

For branch-gated material, move the branch to a sibling file and leave a
one-line pointer: `if X, read Y`. In-repo exemplars include `afk`'s Actions-lane
reference, `tdd`'s topic references, and `prototype`'s `LOGIC.md` versus `UI.md`.

### When to split a leg-work phase

When an early gather or interview phase is repeatedly rushed because the final
artifact is visible in the same skill, split that phase into its own skill. The
separate load boundary hides the payoff until the gather phase meets its own
completion criterion.

In-repo exemplars: `/start` hands off to `/to-spec`, and `writing-fragments` is
separate from `writing-shape` and `writing-beats`.

### TROUBLESHOOTING references

Operational `TROUBLESHOOTING.md` references use one fixed playbook entry format:
Symptom -> Confirm -> Recover -> Root fix. Define that convention here and have
each reference link back to `writing-for-agents` instead of re-explaining it.

Docs-contract tests for TROUBLESHOOTING references assert file existence, the SKILL.md link, and stable load-bearing headings. They do not assert prose wording; pinning prose turns a documentation contract into a stale-doc test.

## Review checklist (after the draft compiles)

- [ ] The description's second sentence begins with `"Use when …"`.
- [ ] The description names every trigger branch, including agent-read file
      types that would otherwise miss the context pointer.
- [ ] Always-loaded material earns its context load.
- [ ] Every step has clear and appropriately demanding completion criteria.
- [ ] One term names each concept; no synonym drift remains.
- [ ] Concrete before → after or input → output examples are present.
- [ ] Disclosed references stay one level deep and state their activation condition.
- [ ] Steps read imperative and bold-led.
- [ ] Each paragraph passes the no-op test.
- [ ] Environment caches and sediment are pruned.
- [ ] Negation has been rewritten to the positive target or paired inline with it.
- [ ] Every silence is a deliberate open branch rather than an accidental gap.

</supporting-info>
