# SKILL.md Writing Style

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

9. **Leading Word + Completion Criterion** — compress the core behavior into one
   pretrained domain term, then bind each step to a checkable completion bar.
   The Leading Word recruits the right prior every time it appears; the
   Completion Criterion tells the agent when that unit is actually done.
   - Before: `Build a thin end-to-end path through every layer first, then flesh out.`
   - After: `Ship a **tracer bullet** first — done only when one request crosses every layer and returns a visible result.`

Use the nine techniques to resist **Premature Completion**: if a step is vague,
the agent will feel the pull of the later steps and leave early. Sharpen the
Completion Criterion first; split the phase only when the criterion is
irreducibly fuzzy and the visible later work keeps causing the rush.

## Steering Failure Modes

**Negation** — a skill that steers by prohibition drags the forbidden behaviour into context and makes it more available. "Don't invent files" activates file-invention before the model reads past it. The cure: replace every prohibition with a positive directive. Where a hard ban is unavoidable, pair it on the same line with the correct alternative — `emit DONE` not `don't write done`.

**Negative Space** — every case a skill leaves silent is delegated to the model's priors, not held neutral. Silences are not free: the model fills them from training, and training may not match the author's intent. The cure: read a draft for its silences and decide each omission deliberately. Fill it with the intended behaviour, or mark it as an acknowledged open branch. "Unaddressed" is not a valid final state.
