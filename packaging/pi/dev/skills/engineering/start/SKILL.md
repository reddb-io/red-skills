---
name: start
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (.red/CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
argument-hint: "[plan to grill: prose, URL, path, or empty] [--tags a,b]"
---

<what-to-do>

**Interview the user relentlessly until you reach a shared understanding — that understanding is the only exit condition.** Map the work as a **design tree**: every decision branches into the decisions hanging off it.

Work the tree in **rounds**. The **frontier** is every unresolved decision whose prerequisites are already settled — the questions answerable *now*, without guessing at answers you have not heard yet. Ask the whole frontier as one round, then wait. Each round's answers reshape the tree: a settled decision pushes the frontier outward and unblocks what depended on it. Recompute the frontier and ask the next round, always pushing as fast as the tree allows.

**A question whose answer depends on another question open in this round belongs to the NEXT round.** That single rule is what makes a round safe — it is why a batch of questions never asks the user to guess at an answer they have not given yet.

A round is as small as the tree makes it. One critical question that unblocks everything downstream is a complete round.

**The loop:**

1. Compute the frontier — every unresolved decision whose prerequisites are settled.
2. Ask that whole frontier as one numbered round, each question carrying its branches and your recommendation.
3. Wait for the user's answers. They may answer by number, in bulk, or push back on the framing.
4. Re-evaluate the tree against what they answered before computing the next frontier.
5. Stop when the frontier is empty, or when the user says stop.

## Question format

Each question is formatted like so — the emoji are load-bearing, because a round of five questions is read by scanning for them:

```
❓ **Q##** — <the question, ONE line, ending in a question mark>
**Branches:**
  (a) <option A>
  (b) <option B>
  (c) <option C>

➡️ **(<letter>)**: <one-sentence reason>
```

**One line per thing to read: the question is a line, and each branch is a line of its own.** A round is read by scanning, and both failures break the scan — a question that swells into a paragraph loses the reader's place, and branches run together on one line make the reader parse separators to find the option they want. Keep the question to a single line that ends in a question mark, and put every branch on its own indented line.

**The ask and its options are one block; the recommendation stands apart.** The branch list is part of the question — it is what the question offers — so it sits directly under it with no blank line. The recommendation is a separate act, so a blank line separates it, and a colon rather than a dash marks where the reason begins.

**Evidence goes above the round, never inside a question.** Whatever the user needs in order to answer — what you found in the code, the numbers, the trade-off you are weighing — belongs in prose *before* the first `❓`, written once for the whole round. A question is the ask alone.

Separate consecutive questions with a blank line, so each `❓` starts its own visual block.

**Enumerate the branches whenever the decision space is finite.** They give the user a stable handle — "ok (b) but with X tweak" — and force the skill to make the choice space explicit instead of gesturing at it. Keep each branch to a short phrase; a branch needing a sentence of explanation is evidence that belongs above the round. Omit `Branches:` only when the question is genuinely open-ended; `➡️` then recommends in prose.

Close each round with a one-line invitation to answer, redirect, or push back.

Number every question `Q01`, `Q02`, … `Q10`, … zero-padded to 2 digits, **continuous across rounds**. The counter is session-scoped — never reset on a new round, never on a user redirect.

## Finding facts is your job, never the user's

**Look facts up; put decisions to the human.** What the code does, what names exist, how something is wired, what a doc already says — read it. Asking the human for what the repo already answers spends their turn on your legwork.

**A fact still being fetched is an unsettled prerequisite — never a blocked round.** Ask everything not downstream of that fact now, and let the question that needs it fall into the next round, exactly as any other dependency would.

Explore read-only. This skill reads the codebase; it does not change it.

## Boot behavior (turn 1 — first invocation only)

The argument is optional. Treat it as the plan or context to grill.

- **External reference** (URL or file path) → eager ingest via `/wiki ingest <ref>`. If `.red/wiki/` is not initialised, ask **once**: `Initialise /wiki to cache fetches across sessions? (y/N)`. On `y`, run `/wiki-init` then proceed. On `n`, fall back to plain `WebFetch`/`Read` into context and note in the receipt that the material is **not cached**.
- **Inline document** (text pasted in the argument) → already in context, no fetch.
- **Prose** (short description) → no fetch, the prose is the plan.
- **Empty argument** → open with the literal `Q01` as a one-question round:

  > ❓ **Q01** — What plan are we grilling?
  > **Branches:**
  >   (a) paste it inline
  >   (b) share a URL or file path
  >   (c) describe it in a sentence
  >
  > ➡️ **(a)**: inline context lets us start grilling immediately.

After successful ingestion, emit a **single-line receipt** then open the first round:

| Source | Receipt |
|---|---|
| URL | `Fetched <url> → wiki/raw/<slug>.md (<N> words).` |
| File (md/txt) | `Read <path> → wiki/raw/<slug>.md.` |
| File (PDF) | `Read <path> → wiki/raw/<slug>.txt (<N> pages).` |
| Inline doc | `Got <N> words inline.` |
| Prose | _(no receipt — open the first round immediately)_ |

When wiki is **not cached** (user declined `/wiki-init`), append ` (not cached)` to the receipt.

On ingestion **failure**, do not open the first round. Ask for an alternative:

```
Couldn't read <ref>: <reason>.
Paste the content, point to another path, or say "skip" and we'll grill on what you describe.
```

## End-of-session doc-landing finalizer

When the frontier is empty — or the user stops — run the shared end-of-session doc-landing finalizer in [DOC-LANDING-FINALIZER.md](./DOC-LANDING-FINALIZER.md) before exiting. An empty frontier is a checkable bound; the finalizer is what turns it into a landed paper trail rather than an open-ended goodbye.

**Hard rules — do not break these:**

- ❌ Do **not** ask a question whose answer depends on another question open in the same round — it belongs to the next round, once its prerequisite is settled.
- ❌ Do **not** let a question run past one line. The evidence behind it goes above the round, where it is written once and read once.
- ❌ Do **not** implement, write code, or run commands beyond read-only codebase exploration, except for the end-of-session doc-landing finalizer.
- ❌ Do **not** summarise the user's answers back at them. They know what they said.
- ❌ Do **not** propose a final plan, design doc, or Spec. This skill ends in shared understanding, not artefacts.
- ❌ Do **not** fetch URLs the user only **mentions** in passing. A ref becomes a fetch only when the user explicitly asks ("look at this", "ingest X") or a frontier question requires its content.
- ❌ Do **not** answer a decision yourself — an agent that answers its own questions has broken the interview.
- ✅ **Do** look up facts in the codebase (what the code does, what names exist, how something is wired) instead of asking the human for information already readable in the code.
- ✅ **Do** put every decision to the human and wait for the answer. Facts can be looked up; decisions belong to the human.
- ✅ **Do** challenge contradictions immediately — between user statements, between user and code, between user and `.red/CONTEXT.md`.
- ✅ **Do** update `.red/CONTEXT.md` inline the moment a term is resolved (one term → one edit → next round). This is a side effect of the interview, not a separate phase.
- ✅ **Do** offer an ADR only when the three-condition test in `<supporting-info>` passes.
- ✅ **Do** treat mid-grilling refs symmetrically to boot refs: when the user introduces a URL or file path at any turn, ingest via `/wiki ingest`, emit the same receipt line, then continue with the next round.
- ✅ **Do** record a `--tags a,b` argument as a session decision ("this work belongs to territory tags a, b") so a downstream `/to-spec` applies the `tag:<value>` labels on publish. `/start` itself still creates no issues and no labels — the tags only travel forward.

</what-to-do>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation:

### File structure

Most repos have a single context:

```
/
├── .red/
│   ├── CONTEXT.md
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `.red/CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. Everything still lives under the single root `.red/` — the map lists the contexts and each one's glossary lives under `.red/contexts/<name>/`:

```
/
├── .red/
│   ├── CONTEXT-MAP.md                 ← lists the contexts and how they relate
│   ├── contexts/
│   │   ├── ordering/CONTEXT.md
│   │   └── billing/CONTEXT.md
│   └── adr/                           ← single root ADR sequence (all contexts)
└── src/
    ├── ordering/
    └── billing/
```

Create files lazily — only when you have something to write. If no `.red/CONTEXT.md` exists, create one when the first term is resolved. If no `.red/adr/` exists, create it when the first ADR is needed.

## Side-effect triggers during the interview

These fire **as a consequence of grilling**. They never replace the interview loop — finish writing, then ask the next round.

### Trigger: user introduces an external reference

URL or file path appears in the user's message **with intent to ingest** ("look at this", "olha esse", "ingest …", or a frontier question clearly needs it). Hand off to `/wiki ingest <ref>`, emit the standard receipt line as a brief acknowledgement, then proceed to the next round. Mid-grilling refs follow the same rules as boot refs — no extra opt-in once `/wiki` is initialised.

### Trigger: term conflicts with the glossary

When the user uses a term that conflicts with the existing language in `.red/CONTEXT.md`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Trigger: fuzzy or overloaded language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Trigger: domain relationship being asserted

Stress-test with a specific scenario. Invent edge cases that force the user to be precise about the boundaries between concepts.

### Trigger: user statement contradicts the code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Trigger: a term is resolved

Update `.red/CONTEXT.md` right there. Don't batch. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

`.red/CONTEXT.md` is a **glossary**. It is totally devoid of implementation details. Do not treat it as a spec, a scratch pad, or a repository for implementation decisions.

### Trigger: a decision passes the ADR test

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

## Wiki integration (if enabled by Memory plugin)

External references (URL, PDF, md/txt) flow through the `/wiki` skill so every fetched source is cached at `.red/wiki/raw/<slug>.md` and reusable across sessions and other skills (`/diagnose`, `/afk`, `/tdd`).

Behaviour summary (full contract in [`/wiki`](../../../../memory/skills/core/wiki/SKILL.md)):

- URL → `WebFetch` → `.red/wiki/raw/<slug>.md` with YAML header (`url`, `fetched`, `title`).
- Local PDF → `pdftotext` → `.red/wiki/raw/<slug>.txt`, original kept alongside.
- Local md/txt → copied to `.red/wiki/raw/<slug>.md` if not already there.
- Every ingest is logged at `.red/wiki/log.md`.

When `.red/wiki/` is missing, `/start` prompts once to run `/wiki-init`. Decline path: plain `WebFetch`/`Read` into context, no caching, receipt marked `(not cached)`.

</supporting-info>
