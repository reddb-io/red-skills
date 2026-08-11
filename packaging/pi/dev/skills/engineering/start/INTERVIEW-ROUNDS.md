# Interview rounds — the shared question convention

**Every question a RedSkills skill asks a human follows this convention.** It is
the one normative home for the round format: `/start` grills with it, and every
other interviewing surface — `/wayfinder` charting and grilling tickets,
`/reflect`, `/hitl`, `/to-spec` — reads and follows this file rather than
restating it. One convention, N consumers, zero drift.

## Question format

Each question is formatted like so — the emoji are load-bearing, because a
round of five questions is read by scanning for them:

```
❓ **Q##** — <the question, ONE line, ending in a question mark>
**Branches:**
  (a) <option A>
  (b) <option B>
  (c) <option C>
➡️ **(<letter>)** — <one-sentence reason>
```

**One line per thing to read: the question is a line, and each branch is a line
of its own.** A round is read by scanning, and both failures break the scan — a
question that swells into a paragraph loses the reader's place, and branches run
together on one line make the reader parse separators to find the option they
want. Keep the question to a single line that ends in a question mark, and put
every branch on its own indented line.

**Evidence goes above the round, never inside a question.** Whatever the user
needs in order to answer — what you found in the code, the numbers, the
trade-off you are weighing — belongs in prose *before* the first `❓`, written
once for the whole round. A question is the ask alone.

Separate consecutive questions with a blank line, so each `❓` starts its own
visual block.

**Enumerate the branches whenever the decision space is finite.** They give the
user a stable handle — "ok (b) but with X tweak" — and force the skill to make
the choice space explicit instead of gesturing at it. Keep each branch to a
short phrase; a branch needing a sentence of explanation is evidence that
belongs above the round. Omit `Branches:` only when the question is genuinely
open-ended; `➡️` then recommends in prose.

Close each round with a one-line invitation to answer, redirect, or push back.

## Numbering

Number every question `Q01`, `Q02`, … `Q10`, … zero-padded to 2 digits,
**continuous across rounds**. The counter is session-scoped — never reset on a
new round, never on a user redirect.

## Rounds over the frontier

Ask in **rounds**: the **frontier** is every unresolved question whose
prerequisites are already settled — the questions answerable *now*, without
guessing at answers not yet given. Ask the whole frontier as one round, then
wait. **A question whose answer depends on another question open in this round
belongs to the NEXT round** — that single rule is what makes a batch safe. A
round is as small as the frontier makes it: one critical question that unblocks
everything downstream is a complete round.
