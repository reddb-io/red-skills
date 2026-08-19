---
name: reflect
working-mode: interactive
description: Interview the user relentlessly about a plan or design until reaching shared understanding, resolving each branch of the decision tree. Use when user wants to stress-test a plan, reflect on a design, or mentions "reflect".
---

<what-to-do>

**Interview the user — one question per turn, one recommendation per question — until every branch of this plan is understood.** Do not stack questions; do not skip ahead.

Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, include your recommended answer with a one-sentence reason.

**Read [`/start`'s INTERVIEW-ROUNDS.md](../../engineering/start/INTERVIEW-ROUNDS.md) and follow its question format for every question you ask** — the `❓ **Q##**` block, per-line branches, the `➡️` recommendation, evidence above the ask. This skill's cadence stays its own: one question per turn is a one-question round, which the convention allows.

Ask the questions one at a time. Wait for the user's reply before proceeding.

If a question can be answered by exploring the codebase, explore the codebase instead of asking.

When the reflection session ends, run the shared end-of-session doc-landing finalizer in [`/start`'s DOC-LANDING-FINALIZER.md](../../engineering/start/DOC-LANDING-FINALIZER.md) before exiting.

</what-to-do>
