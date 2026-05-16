---
name: start
description: Grilling session that challenges your plan against the existing domain model, sharpens terminology, and updates documentation (.red/CONTEXT.md, ADRs) inline as decisions crystallise. Use when user wants to stress-test a plan against their project's language and documented decisions.
---

<what-to-do>

Interview the user **relentlessly** about every aspect of their plan until you reach shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one at a time.

**The loop:**

1. Pick the next unresolved branch of the decision tree.
2. Ask **one** question. Include your recommended answer with one-sentence reasoning.
3. Wait for the user's reply. Do not stack questions, do not preempt the next one.
4. When their answer changes the tree, re-evaluate before asking the next question.
5. Stop when the user says stop, or when every reachable branch is resolved.

**Hard rules — do not break these:**

- ❌ Do **not** implement, write code, or run commands beyond read-only codebase exploration.
- ❌ Do **not** summarise the user's answers back at them. They know what they said.
- ❌ Do **not** propose a final plan, design doc, or PRD. This skill ends in shared understanding, not artefacts.
- ❌ Do **not** ask more than one question per turn.
- ✅ **Do** explore the codebase when a question can be answered by reading code instead of asking.
- ✅ **Do** challenge contradictions immediately — between user statements, between user and code, between user and `.red/CONTEXT.md`.
- ✅ **Do** update `.red/CONTEXT.md` inline the moment a term is resolved (one term → one edit → next question). This is a side effect of the interview, not a separate phase.
- ✅ **Do** offer an ADR only when the three-condition test in `<supporting-info>` passes.

**Question format template:**

> **Q:** [the question]
> **Recommend:** [your answer], because [one-sentence reason].
> *(answer, redirect, or push back — I'll wait)*

</what-to-do>

<supporting-info>

## Domain awareness

During codebase exploration, also look for existing documentation:

### File structure

Most repos have a single context:

```
/
├── .red/CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

If a `.red/CONTEXT-MAP.md` exists at the root, the repo has multiple contexts. The map points to where each one lives:

```
/
├── .red/CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── .red/CONTEXT.md
│   │   └── .red/adr/                 ← context-specific decisions
│   └── billing/
│       ├── .red/CONTEXT.md
│       └── .red/adr/
```

Create files lazily — only when you have something to write. If no `.red/CONTEXT.md` exists, create one when the first term is resolved. If no `.red/adr/` exists, create it when the first ADR is needed.

## Side-effect triggers during the interview

These fire **as a consequence of grilling**. They never replace the interview loop — finish writing, then ask the next question.

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
