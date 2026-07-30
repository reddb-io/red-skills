---
name: report-bug
description: Interview the user about a bug they hit, then file a structured `type:bug needs-triage` issue on the project tracker. Pulls seed material from the conversation context when invoked with no arguments, or from the argument when one is provided. Use when the user says "report a bug", "open a bug", "this is broken — file it", "/report-bug ...", or otherwise wants a bug captured on the tracker without going through full triage themselves.
argument-hint: "[symptom — leave empty to seed from conversation]"
disable-model-invocation: true
---

<what-to-do>

**You file, /triage routes. Never pre-label or guess priority.**

Conduct a short, focused interview that fills in every field of the issue template in `<supporting-info>`, then open the issue on the project tracker.

**Boot behavior (turn 1):**

The argument is optional.

- **Argument present** → treat it as the seed for "What's happening". Emit a single-line receipt confirming the seed (`Seed: <first 80 chars>…`), then jump to the next missing field.
- **Argument empty** → silently mine the current conversation context for: what the user was doing, error messages, file paths, stack traces, recent commands, anything that smells like the symptom of the bug. Emit a one-line receipt (`Seeded from conversation: <one-sentence summary>.`) and start the interview with whichever field is still least clear.
- **No useful context AND no argument** → open with `Q01: What's the bug? Describe what you observed.`

**The loop:**

1. Pick the next unresolved field from the template in `<supporting-info>`.
2. Ask **one** question using the format below. Include a recommended answer or `[branches]` whenever the field has a finite shape (severity, repro type), otherwise ask open-ended.
3. Wait for the user's reply. Do not stack questions.
4. When their answer changes the picture (e.g. severity escalates from "low" to "blocker" because they mention prod), re-evaluate before asking the next question.
5. Once every field is filled, summarise the issue as it will be filed (title + body), ask `Q##: Open this issue on the tracker? (y/n / edit)`. On `y` or `yes`, proceed. On `edit`, ask which field to revise. On `n`, abort cleanly.

**Filing:**

1. Build the issue title per **Title rules** in `<supporting-info>` (lowercase, ≤72 chars, imperative/noun phrase derived from "What's happening").
2. Render the body using the exact template in `<supporting-info>`. Leave no `[…]` placeholders.
3. `gh issue create --title "<title>" --body "<body>" --label type:bug --label needs-triage`. Pass body via heredoc/tempfile, not inline, to preserve newlines.
4. Read the URL from the gh output and present it to the user with one of: open URL, run `/triage`, or stop.

**Hard rules:**

- ❌ Do **not** invent reproduction steps, error text, or file paths. If the user can't supply them, write `no clean repro yet` and `unknown` rather than fabricating.
- ❌ Do **not** apply any label beyond `type:bug` + `needs-triage` — see **Labels** in `<supporting-info>`; `/triage` owns priority, slice tagging, and agent-readiness.
- ❌ Do **not** close the issue, comment after creation, or run any AFK action. This skill ends with the URL.
- ❌ Do **not** open more than one issue per invocation. If the user describes two unrelated bugs, suggest running `/report-bug` again for the second.
- ✅ **Do** number every question `Q##:` (zero-padded, session-scoped, same convention as `/start`).
- ✅ **Do** use `gh` (not the GitHub web UI) — the user invoked a CLI skill, they want the issue handle in the terminal.
- ✅ **Do** sanitise the body before filing: strip ANSI escapes, mask anything that looks like a secret (API keys, tokens) — when in doubt, ask the user to confirm.
- ✅ **Do** route the user to `/triage` after creating the issue — see **After creation** in `<supporting-info>` for the exact receipt. The reporter's job ends at "captured".

**Question format template:**

> **Q##:** [the question]
> **Branches:** _(omit when the field is open-ended free text)_
> (a) [answer option A]
> (b) [answer option B]
> [if more options, add more branches]
> **Recommend:** (a), because [one-sentence reason].
> *(answer, redirect, or push back — I'll wait)*

</what-to-do>

<supporting-info>

## Issue body template

````markdown
## What's happening

<one to three sentences describing the observed behaviour, verbatim from the user where possible>

## What should happen instead

<one or two sentences describing the expected behaviour>

## Reproduction

<numbered steps, or `no clean repro yet — observed in <context>`>

## Context

- **when:** <date/time the user noticed, ISO format if known>
- **where:** <file path, route, URL, component name>
- **what i was doing:** <one sentence>
- **environment:** <OS, runtime version, branch/commit if relevant; "n/a" otherwise>

## Severity

<one of: blocker | high | medium | low | unknown>

## Source

Filed via `/report-bug`. <"Seeded from inline argument." | "Seeded from conversation context." | "No prior context.">
````

Fields that the interview must fill, in order of priority:

1. **What's happening** — symptom, observed behaviour.
2. **What should happen instead** — expected behaviour. If user can't articulate, ask "what made you think this was a bug and not the design?"
3. **Reproduction** — numbered steps if the user can produce them; otherwise the rough conditions (`no clean repro yet — observed when X`).
4. **Context** — `when`, `where`, `what i was doing`, `environment`. Pull from conversation if mined; ask only for what's missing.
5. **Severity** — branches: blocker / high / medium / low / unknown.
6. **Source** — auto-filled from boot mode.

## Severity branches

Use these when asking `Q##: Severity?`:

- **blocker** — production is down or data is at risk now.
- **high** — a core flow is broken; workaround is awkward or partial.
- **medium** — broken in a non-core path or has a clean workaround.
- **low** — cosmetic, minor, or rare edge.
- **unknown** — pick this freely; `/triage` will assign properly.

## Title rules

- Lowercase, ≤72 chars.
- Imperative or noun phrase: `monitor crashes on empty history.jsonl`, `wiki ingest mangles assets folder`, `afk loses claim when worker_id collides`.
- Avoid prefixes like `Bug:`, `[BUG]`, `Issue:` — the `type:bug` label already conveys this.
- Avoid clickbait — `WTF`, `???`, `please fix` waste tokens for the next reader.

## Labels

Apply exactly two on creation:

- `type:bug`
- `needs-triage`

The `/triage` skill is responsible for adding the rest (`priority:*`, `prd:*`, eventually `ready-for-agent`). Pre-emptively labelling here breaks that contract.

If `type:bug` or `needs-triage` don't exist in the repo (fresh checkout), stop and tell the user to run `/red-setup` first — same precondition as `/triage`.

## Conversation-mining heuristic

When invoked with no argument, scan the conversation transcript (most recent ~50 turns) for:

- Error messages, stack traces, non-zero exit codes.
- File paths the user just opened or edited.
- Recently failing test names.
- Commands the user ran that produced unexpected output.
- Explicit phrases: "this is weird", "shouldn't this …", "why is it doing …", "I expected … but got …".

Pick the strongest signal as the seed for "What's happening" and surface what's still missing for the rest of the fields.

If nothing useful is in the transcript, say so in the receipt (`Seeded from conversation: no clear symptom found, starting open.`) and open with `Q01`.

## After creation

When the issue is filed, print exactly:

```
✓ filed #<N>: <title>
  <url>
  next: /triage to assign priority and route to /afk.
```

Then stop. Do not call `/triage` yourself unless the user explicitly asks.

</supporting-info>
