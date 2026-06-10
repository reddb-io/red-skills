---
name: ff
description: Reframes the user's latest message into several useful versions with short previews and one explicit recommendation, then hands the chosen rewrite back to the user — it does NOT execute the underlying task unless invoked with `--dispatch`/`-d`. Use when the user invokes `/ff`, says fast-forward, asks to rewrite their own message, or wants to clarify intent before acting.
argument-hint: "[--dispatch|-d] [text to reframe]"
---

# /ff

Fast-forward clarity. Reframe the user's latest message, or the text passed after
`/ff`, into multiple preview versions so the user can pick the framing they want.

By default `/ff` **ends by handing the chosen rewrite back to the user** — it does
not start executing the underlying task. Pass `--dispatch` (or `-d`) to have `/ff`
reframe, let the user pick a format, and **then run** the task with that framing.

## Modes

- **`/ff <text>`** (default — reframe only): present the previews, and once the
  user picks a framing, output the finalized rewrite and **stop**. That rewritten
  prompt is the deliverable; the user takes it and decides what to do next. Never
  continue a paused workflow or execute the underlying task.
- **`/ff --dispatch <text>`** / **`/ff -d <text>`** (reframe then run): present the
  previews exactly the same way; once the user picks a framing, adopt that rewrite
  as the active message and **immediately carry out the underlying task**.

`--dispatch`/`-d` may appear anywhere in the arguments; strip it before reframing
the remaining text.

## Contract (both modes)

- While presenting previews, reframe only: do not solve the underlying task, do
  not edit files or run commands, and do not continue a paused `/start`,
  `/diagnose`, `/afk`, or implementation task.
- Return previews for every option below, then stop and wait for the user's pick.
- Start with one recommendation in this exact spirit: `I think you want (x), because ...`
- Keep each preview short by default: 3-8 lines, or a compact summary when the
  source text is long.

## Output

Use this shape:

```md
I think you want (a), because ...

(a) For a junior dev
...

(b) For a 10-year-old
...

(c) For a senior dev
...

(d) As an improved prompt
...

(e) As an implementable issue
...

(f) As a decision request
...

(g) Short and direct
...
```

## Option Semantics

- **(a) For a junior dev**: precise but simple technical language, minimal jargon, practical examples.
- **(b) For a 10-year-old**: plain language, one analogy if useful, no patronizing tone.
- **(c) For a senior dev**: dense technical vocabulary, explicit assumptions, constraints, edge cases, and tradeoffs.
- **(d) As an improved prompt**: prompt-engineered request with role/context, objective, constraints, desired output, and success criteria.
- **(e) As an implementable issue**: title, context, scope, acceptance criteria, and validation.
- **(f) As a decision request**: decision needed, options, tradeoffs, recommendation, and what answer unblocks.
- **(g) Short and direct**: the shortest clear version.

## When the user picks a framing

The user picks with phrases like `use a`, `mix a with d`, or `go with that one`.

- **Default mode** (no `--dispatch`): produce the finalized rewrite from the chosen
  option(s) and **stop**. Hand that rewritten prompt back — do not start executing it.
- **`--dispatch` mode**: produce the finalized rewrite from the chosen option(s),
  adopt it as the active message, and **proceed to carry out the underlying task**.
