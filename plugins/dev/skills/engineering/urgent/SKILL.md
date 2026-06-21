---
name: urgent
description: Create a `priority:urgent` issue that bypasses triage and jumps to the front of the `/afk` queue — the next AFK iteration is guaranteed to pick it up, even when AFK is running with a `--prd N` or `--issues a,b,c` filter. Use when something is on fire (production down, security regression, blocking another team) and the standard reporter → triage → AFK pipeline is too slow.
argument-hint: "[urgent task — leave empty for a 2-question interview]"
---

<what-to-do>

**One fire per invocation — no triage bypass for "I want it sooner".**

Create one issue with labels `priority:urgent` + `ready-for-agent`, then stop. The next `/afk` invocation picks it up first.

**Boot behavior (turn 1):**

The argument is optional.

- **Argument present** → seed for the "What's urgent" field. Emit a one-line receipt (`Seed: <first 80 chars>…`) and jump to whichever of the two interview questions still needs an answer.
- **Argument empty** → open with `Q01: What's urgent? One line — what's on fire?`

**The interview (two questions, no more):**

1. `Q01:` What's the urgent task? (free text — what's broken / what must happen now)
2. `Q02:` Why now? (free text — one sentence on what makes this `priority:urgent` and not just `priority:high`)

The second question is a real filter, not ceremony. If the user can't articulate a reason for urgency beyond "I want it sooner", **push back**: suggest `/report-bug` (for a fresh bug) or `/triage` (to set `priority:high` on an existing issue) instead. Urgent is a budget — not every fast-track is urgent.

After both answers are in, summarise the issue as it will be filed (title + body), ask `Q03: Open this urgent issue and queue it for AFK? (y/n / edit)`. On `y`, file it.

**Filing:**

1. **Title** — short imperative, ≤72 chars, lowercase. No `URGENT:` / `🚨` prefix — the label carries the signal.
2. **Body** — use the template in `<supporting-info>`. Inline the "What's urgent" and "Why now" answers verbatim.
3. **Labels** — `priority:urgent` + `ready-for-agent`. **Do not** add `needs-triage`, `type:bug`, `priority:high`, or anything else.
4. **Create**: `gh issue create --title "<title>" --body "<body>" --label priority:urgent --label ready-for-agent`. Pass the body via heredoc/tempfile to preserve newlines.
5. **Preconditions** — if the label `priority:urgent` doesn't exist in the repo, create it first: `gh label create priority:urgent --color B91C1C --description "Jumps the AFK queue; bypasses triage."`. Catch the conflict (label may already exist) and continue.

**After creation:**

Print exactly:

```
✓ filed #<N> [URGENT]: <title>
  <url>
  next AFK iteration will pick this up first, ahead of any --prd / --issues filter.
```

Then stop. Do not invoke `/afk` automatically — if a worker is already running it will pick up `priority:urgent` on its next claim (Issue Selection re-fetches the queue each iteration). If no worker is running, the user starts `/afk` themselves.

**Hard rules:**

- ❌ Do **not** open more than one `priority:urgent` issue per invocation. If the user describes two fires, suggest re-running `/urgent` for the second.
- ❌ Do **not** apply `needs-triage`. The whole point of `/urgent` is to skip triage. If you find yourself wanting to triage, the issue isn't urgent — route the user to `/report-bug` instead.
- ❌ Do **not** start `/afk` from inside this skill. Creation is the contract; running is the user's call.
- ❌ Do **not** mass-promote existing issues to urgent. One invocation = one new issue.
- ✅ **Do** sanitise the body for ANSI escapes and likely secrets (API keys, tokens) before filing.
- ✅ **Do** push back on weak urgency rationales. "I just want it sooner" → suggest `/report-bug` or relabel-via-`/triage` (`priority:high`).
- ✅ **Do** number questions `Q01`, `Q02`, `Q03` zero-padded, session-scoped.

**Question format template:**

> **Q##:** [the question]
> *(answer, redirect, or push back — I'll wait)*

Branches are not used here — both interview questions are open-ended free text.

</what-to-do>

<supporting-info>

## Issue body template

````markdown
## What's urgent

<verbatim from the user's Q01 answer — keep it tight, one to three sentences>

## Why now

<verbatim from Q02 — one sentence on what makes this `priority:urgent` and not `priority:high`>

## Source

Filed via `/urgent`. Bypassed `/triage` by design. AFK selection prepends `priority:urgent` issues to its queue on every iteration, ahead of any `--prd` / `--issues` filter.
````

The template is intentionally minimal — there's no Reproduction or Context section. Urgent issues are "do this now, sort out the rest later". The agent (via `/afk`) will read the body, ask follow-ups via `## Notes` if needed, and proceed.

If the user volunteers extra context during the interview (file path, error message, link), append a `## Notes` section to the body with that material. Don't ask for it.

## Title rules

Same conventions as `/report-bug`:

- Lowercase, ≤72 chars.
- Imperative or noun phrase: `revoke leaked API key`, `restore broken /signup flow`, `unblock postgres failover script`.
- No `URGENT:` / `🚨` / `[URGENT]` prefix — the label is the signal, and the title needs to read cleanly in `gh issue list` output.

## Labels

Apply exactly two:

- `priority:urgent` — the AFK queue marker. Create it via `gh label create` if missing (colour `B91C1C`, description `"Jumps the AFK queue; bypasses triage."`).
- `ready-for-agent` — the existing state that AFK consumes.

Do not add anything else. In particular:

- **No `needs-triage`** — that gate is what `/urgent` bypasses.
- **No `priority:high`** — adding both is contradictory and confuses the AFK sort.
- **No `type:bug`** — urgent is orthogonal to type. The next reader of the issue should be able to tell from the body whether it's a bug, a feature flip, an ops action, etc.

## How AFK honours urgent

`/afk` issue_selection now does:

1. Fetch all open `priority:urgent ready-for-agent` issues (independent of any `--prd` / `--issues` filter).
2. Fetch the filtered list as before (`--prd`, `--issues`, or all `ready-for-agent`).
3. Concat: urgent first (ordered by issue number ascending, so the oldest fire goes first), then the filtered list, deduplicated.

Result: every iteration of every `/afk` run claims a `priority:urgent` issue before anything else, regardless of which `/afk` invocation flags were used. Once urgents are drained, the original filter takes over.

If two `/afk` workers are running in parallel and there's one urgent issue, the existing claim lock (`mkdir .red/tmp/claims/{N}/`) ensures only one wins it — the other proceeds to its next candidate.

## When NOT to use `/urgent`

- A bug you discovered that isn't actively breaking anyone: `/report-bug`.
- An issue you want sooner but not at the cost of jumping the queue: `/triage` and bump to `priority:high`.
- A whole batch of "important" work: `/to-issues` plus `priority:high`.
- Something the team agreed should be next but you don't want to skip review: open a regular issue, let `/triage` walk it through.

`/urgent` is a budget. Spend it like one.

</supporting-info>
