---
name: ff
working-mode: interactive
description: Reframes the user's message into one chosen framing through a two-step interaction — first asks which framing to rewrite into, then generates that single rewrite and asks whether to dispatch (execute) it. Use when the user invokes `/ff`, says fast-forward, asks to rewrite their own message, or wants to clarify intent before acting.
argument-hint: "[--dispatch|-d] [text to reframe]"
disable-model-invocation: true
---

# /ff

Fast-forward clarity. Reframe the user's latest message, or the text passed after
`/ff`, into **one** chosen framing — through two sequential questions, asked one
at a time with the user's interaction between them.

`/ff` does NOT dump every framing at once. It asks which framing the user wants
first, generates only that one rewrite, then asks whether to dispatch it.

<what-to-do>

**Reframe the user's message through exactly one chosen framing, via two sequential interactions — pick the framing first, generate the rewrite second.** Never skip ahead or produce multiple rewrites.

Run these two steps in order. Ask one question, wait for the answer, then proceed to the next.

### Step 1 — choose the framing (no rewrite yet — stop and wait for the user's pick)

Present the framing menu with a single recommendation, then **stop and wait**. Do
not generate any rewrite yet — the user picks by label, before seeing any output.

```md
How do you want to rewrite your content?

I think you want (x), because ...

(a) For a junior dev
(b) For a 10-year-old
(c) For a senior dev
(d) As an improved prompt
(e) As an implementable issue
(f) As a decision request
(g) Short and direct
```

The user picks with phrases like `d`, `use a`, or `go with that one`.

### Step 2 — generate the chosen rewrite, then ask to dispatch (only after the user picks from Step 1)

Produce **only** the chosen framing's rewrite and present it, then ask whether to
dispatch:

```md
Result:
{result}

Would you like to dispatch it? Yes/no
```

- **Yes** → adopt `{result}` as the active message and **carry out the underlying
  task** immediately.
- **No** → hand `{result}` back and **stop**. Do not execute anything.

**`--dispatch`/`-d` shortcut**: if the flag was passed in the invocation, **skip
the Yes/no question** — present the `Result:` and immediately dispatch (auto-yes).
The flag may appear anywhere in the arguments; strip it before reframing the
remaining text.

### Hard rules

- ✅ Generate exactly **one** rewrite — the chosen framing. Never preview all of them.
- ✅ In Step 1, reframe only: do not solve the task, edit files, run commands, or
  continue a paused `/start`, `/diagnose`, `/afk`, or implementation task.
- ✅ Keep the rewrite tight: a few lines, or a compact summary when the source is long.
- ❌ Do not execute anything until the user answers Yes in Step 2 (or passed `-d`).
- ❌ Do not collapse the two steps into one turn — the menu and the result are
  separate questions.

</what-to-do>

<supporting-info>

## Worked example — framing (e) end-to-end

User invokes `/ff implement error handling for this API`.

**Step 1 output (stop — wait for the user's pick):** print the Step 1 framing
menu (see `<what-to-do>`), recommending `(e)` — "because it's an implementation
task that could be scoped as a ticket."

User replies: `e`

**Step 2 output (generate + ask to dispatch):**

```
Result:
**Add error handling to the payment API endpoint**
Context: The `/api/payment` endpoint currently lets uncaught exceptions propagate to the caller.
Scope: Wrap the handler in try/catch; return `{ error: "…", code: 500 }` on failure; log via the existing logger.
Acceptance criteria: non-2xx responses are structured JSON; errors are logged; no uncaught exceptions escape.
Validation: manual smoke test + existing integration tests pass.

Would you like to dispatch it? Yes/no
```

User replies: `yes` → carry out the implementation task described above.

---

## Framing semantics

- **(a) For a junior dev**: precise but simple technical language, minimal jargon, practical examples.
- **(b) For a 10-year-old**: plain language, one analogy if useful, no patronizing tone.
- **(c) For a senior dev**: dense technical vocabulary, explicit assumptions, constraints, edge cases, and tradeoffs.
- **(d) As an improved prompt**: prompt-engineered request with role/context, objective, constraints, desired output, and success criteria.
- **(e) As an implementable issue**: title, context, scope, acceptance criteria, and validation.
- **(f) As a decision request**: decision needed, options, tradeoffs, recommendation, and what answer unblocks.
- **(g) Short and direct**: the shortest clear version.

</supporting-info>
