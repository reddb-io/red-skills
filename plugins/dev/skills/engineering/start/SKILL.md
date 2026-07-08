---
name: start
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (.red/CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
argument-hint: "[plan to grill: prose, URL, path, or empty]"
---

<what-to-do>

**Run a relentless one-Q-at-a-time grilling session until every branch of the decision tree is resolved — shared understanding is the only exit condition.** Ask one question, include a recommendation with one-sentence reasoning, wait for the reply, re-evaluate, then move to the next branch.

Walk down each branch of the design tree, resolving dependencies between decisions one at a time.

**The loop:**

1. Pick the next unresolved branch of the decision tree.
2. Ask **one** question. Include your recommended answer with one-sentence reasoning.
3. Wait for the user's reply. Do not stack questions, do not preempt the next one.
4. When their answer changes the tree, re-evaluate before asking the next question.
5. Stop when the user says stop, or when every reachable branch is resolved.

## End-of-session doc-landing finalizer

When the grilling session ends (the user stops or every reachable branch is resolved), run one end-of-session doc-landing finalizer before exiting:

1. Detect modified or untracked docs in the primary checkout across the domain glossary (`.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`) and ADRs (`.red/adr/**`). A session with no doc changes skips the finalizer silently.
2. If docs changed, do this first: Announce the file list and ADR numbers to the user, and accept a decline. A decline leaves the docs unlanded; the cascade gate remains the enforcement point.
3. If accepted, land the docs through the standard lane: create one worktree under `.red/tmp/` from a freshly fetched `origin/{base}` (base resolved lock > pin > main), copy only the dirty doc files into that worktree, commit them as a `docs:`-typed change, push the branch, open a PR, merge it, and rely on the existing post-landing fast-forward to bring the local base up.
4. Restate these safety prohibitions before landing: never commit in the primary checkout, never switch its branch, never stash, never reset.
5. Land at most one batch PR per session.

## Boot behavior (turn 1 — first invocation only)

The argument is optional. Treat it as the plan or context to grill.

- **External reference** (URL or file path) → eager ingest via `/wiki ingest <ref>`. If `.red/wiki/` is not initialised, ask **once**: `Initialise /wiki to cache fetches across sessions? (y/N)`. On `y`, run `/wiki-init` then proceed. On `n`, fall back to plain `WebFetch`/`Read` into context and note in the receipt that the material is **not cached**.
- **Inline document** (text pasted in the argument) → already in context, no fetch.
- **Prose** (short description) → no fetch, the prose is the plan.
- **Empty argument** → open with the literal Q01:

  > **Q01:** What plan are we grilling?
  > **Branches:** (a) paste it inline  (b) share a URL or file path  (c) describe it in a sentence
  > **Recommend:** (a), because inline context lets us start grilling immediately.
  > *(answer, redirect, or push back — I'll wait)*

After successful ingestion, emit a **single-line receipt** then proceed to `Q01`:

| Source | Receipt |
|---|---|
| URL | `Fetched <url> → wiki/raw/<slug>.md (<N> words).` |
| File (md/txt) | `Read <path> → wiki/raw/<slug>.md.` |
| File (PDF) | `Read <path> → wiki/raw/<slug>.txt (<N> pages).` |
| Inline doc | `Got <N> words inline.` |
| Prose | _(no receipt — proceed to Q01 immediately)_ |

When wiki is **not cached** (user declined `/wiki-init`), append ` (not cached)` to the receipt.

On ingestion **failure**, do not start `Q01`. Ask for an alternative:

```
Couldn't read <ref>: <reason>.
Paste the content, point to another path, or say "skip" and we'll grill on what you describe.
```

**Hard rules — do not break these:**

- ❌ Do **not** implement, write code, or run commands beyond read-only codebase exploration, except for the end-of-session doc-landing finalizer.
- ❌ Do **not** summarise the user's answers back at them. They know what they said.
- ❌ Do **not** propose a final plan, design doc, or PRD. This skill ends in shared understanding, not artefacts.
- ❌ Do **not** ask more than one question per turn.
- ❌ Do **not** fetch URLs the user only **mentions** in passing. A ref becomes a fetch only when the user explicitly asks ("look at this", "ingest X") or the next question requires its content.
- ✅ **Do** explore the codebase when a question can be answered by reading code instead of asking.
- ✅ **Do** challenge contradictions immediately — between user statements, between user and code, between user and `.red/CONTEXT.md`.
- ✅ **Do** update `.red/CONTEXT.md` inline the moment a term is resolved (one term → one edit → next question). This is a side effect of the interview, not a separate phase.
- ✅ **Do** offer an ADR only when the three-condition test in `<supporting-info>` passes.
- ✅ **Do** treat mid-grilling refs symmetrically to boot refs: when the user introduces a URL or file path at any turn, ingest via `/wiki ingest`, emit the same receipt line, then continue with the next question.

**Question format template:**

> **Q##:** [the question]
> **Branches:** _(omit only when the question is genuinely open-ended)_
>  (a) [answer option A]
>  (b) [answer option B]
>  [if more options, add more branches]
> **Recommend:** (a), because [one-sentence reason].
> *(answer, redirect, or push back — I'll wait)*

Prefer enumerated branches whenever the decision space is finite — they give the user a stable handle ("ok (b) but with X tweak") and force the skill to make the choice space explicit instead of hand-waving. `Recommend:` references a branch letter when branches are listed, prose otherwise.

Number every question `Q01`, `Q02`, … `Q10`, … zero-padded to 2 digits. Counter is **session-scoped** — reset on each `/start` invocation, never on user redirects.

</what-to-do>

<supporting-info>

## Wiki integration

External references (URL, PDF, md/txt) flow through the `/wiki` skill so every fetched source is cached at `.red/wiki/raw/<slug>.md` and reusable across sessions and other skills (`/diagnose`, `/afk`, `/tdd`).

Behaviour summary (full contract in [`../../knowledge/wiki/SKILL.md`](../../knowledge/wiki/SKILL.md)):

- URL → `WebFetch` → `.red/wiki/raw/<slug>.md` with YAML header (`url`, `fetched`, `title`).
- Local PDF → `pdftotext` → `.red/wiki/raw/<slug>.txt`, original kept alongside.
- Local md/txt → copied to `.red/wiki/raw/<slug>.md` if not already there.
- Every ingest is logged at `.red/wiki/log.md`.

When `.red/wiki/` is missing, `/start` prompts once to run `/wiki-init`. Decline path: plain `WebFetch`/`Read` into context, no caching, receipt marked `(not cached)`.

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

These fire **as a consequence of grilling**. They never replace the interview loop — finish writing, then ask the next question.

### Trigger: user introduces an external reference

URL or file path appears in the user's message **with intent to ingest** ("look at this", "olha esse", "ingest …", or the next question clearly needs it). Hand off to `/wiki ingest <ref>`, emit the standard receipt line as a brief acknowledgement, then proceed to the next `Q##:`. Mid-grilling refs follow the same rules as boot refs — no extra opt-in once `/wiki` is initialised.

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

</supporting-info>
