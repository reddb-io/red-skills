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

## Quick start

[Minimal working example]

## Workflows

[Step-by-step processes with checklists for complex tasks]

## Advanced features

[Link to separate files: See [REFERENCE.md](REFERENCE.md)]
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

## When to add scripts

Add a utility script when the operation is deterministic (validation,
formatting), when the same code would be generated repeatedly, or when errors
need explicit handling. Scripts save tokens and beat generated code on
reliability.

## When to split files

Split into a separate file when SKILL.md exceeds ~100 lines, when content spans
distinct domains (finance vs sales schemas), or when advanced features are
rarely needed — keep references one level deep so the agent never chases a chain.

## SKILL.md writing style

Section structure (`<what-to-do>` / `<supporting-info>`) decides *where* a
sentence goes; this section decides *how the sentence reads*. Apply these eight
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

## Review checklist (run after the draft compiles)

- [ ] Description ends with the literal `"Use when …"` trigger.
- [ ] SKILL.md stays under ~100 lines (excluding this meta-skill).
- [ ] No time-sensitive info.
- [ ] One term per concept — no synonym drift.
- [ ] Concrete before → after or input → output examples included.
- [ ] References stay one level deep.
- [ ] Steps read imperative and bold-led — the skill follows its own style.
