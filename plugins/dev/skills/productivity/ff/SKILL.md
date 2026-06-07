---
name: ff
description: Reframes the user's latest message into several useful versions with short previews and one explicit recommendation. Use when the user invokes `/ff`, says fast-forward, asks to rewrite their own message, or wants to clarify intent without continuing the underlying task yet.
argument-hint: "[optional text to reframe]"
---

# /ff

Fast-forward clarity. Reframe the user's latest message, or the text passed after
`/ff`, into multiple preview versions so the user can pick the framing they want.

## Contract

- Do not solve the underlying task.
- Do not edit files or run commands.
- Do not continue a paused `/start`, `/diagnose`, `/afk`, or implementation task.
- Return previews for every option below, then stop.
- Start with one recommendation in this exact spirit: `Acho que você quer (x), porque ...`
- Keep each preview short by default: 3-8 lines, or a compact summary when the source text is long.

## Output

Use this shape:

```md
Acho que você quer (a), porque ...

(a) Para dev junior
...

(b) Para criança de 10 anos
...

(c) Para dev senior
...

(d) Como prompt melhorado
...

(e) Como issue implementável
...

(f) Como pedido de decisão
...

(g) Versão curta e direta
...
```

## Option Semantics

- **(a) Para dev junior**: precise but simple technical language, minimal jargon, practical examples.
- **(b) Para criança de 10 anos**: plain language, one analogy if useful, no patronizing tone.
- **(c) Para dev senior**: dense technical vocabulary, explicit assumptions, constraints, edge cases, and tradeoffs.
- **(d) Como prompt melhorado**: prompt-engineered request with role/context, objective, constraints, desired output, and success criteria.
- **(e) Como issue implementável**: title, context, scope, acceptance criteria, and validation.
- **(f) Como pedido de decisão**: decision needed, options, tradeoffs, recommendation, and what answer unblocks.
- **(g) Versão curta e direta**: the shortest clear version.

If the user later says `usa a`, `mistura a com d`, or `continua com essa versão`,
use that chosen rewrite as the active message and continue the original workflow.
