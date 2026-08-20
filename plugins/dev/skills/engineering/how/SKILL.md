---
name: how
working-mode: interactive
description: Explain how a subsystem works — "how does X work", code walkthroughs before changing something, placement and layering questions ("where should this live", "is this the right layer") — and, on request, critique its architecture with an independent panel. Use /context for the project context stack, /research for external sources, /diagnose for bugs.
disable-model-invocation: true
---

# How

Explore the codebase to answer "how does X work?". Produce the explanation a
senior engineer needs to onboard onto a subsystem — enough to build a working
mental model, not annotated source code.

Two modes: **Explain** (default) and **Critique** (explain first, then an
independent panel finds architectural issues).

<what-to-do>

## Explain mode

**Step 1 — parse the question and assess complexity.** Identify the scope. If
the question is ambiguous, state your best-guess interpretation and proceed —
do not ask; the user redirects if you are off. Then pick the route:

- **Simple** (one module, a narrow "how does function X work"): one read-only
  subagent explores and explains in a single pass, following
  [`references/explainer-prompt.md`](./references/explainer-prompt.md). Go to
  Step 4. When in doubt, lean simple — you can always spawn explorers if the
  explainer hits a wall.
- **Complex** (a subsystem across files or packages, a cross-cutting feature,
  an architectural overview): go to Step 2.

**Step 2 — explore in parallel (complex only).** Decompose the question into
2–4 non-overlapping exploration angles — distinct slices, so explorers do not
duplicate work (for a rate limiter: data model and state; request path and
enforcement; configuration and metrics). Spawn all explorers **in one
message**, read-only, each with
[`references/explorer-prompt.md`](./references/explorer-prompt.md) plus its
angle. An explorer stops when it can describe the full path from input to
output without hand-waving any step; "I couldn't determine how X connects to
Y" is better than making something up.

**Step 3 — synthesize (complex only).** One read-only explainer subagent gets
every explorer's findings and
[`references/explainer-prompt.md`](./references/explainer-prompt.md). It
reconciles overlaps, resolves contradictions by checking the code itself, and
writes the human-facing explanation in the project's ubiquitous language —
read `.red/CONTEXT-MAP.md` and the owning `.red/contexts/<name>/CONTEXT.md`
when they exist, and use their terms.

**Step 4 — present.** Present the explainer's output. Light edits for clarity
are fine; do not substantially rewrite — the explainer's communication is the
product.

## Critique mode

Triggered when the user asks for architectural issues, problems, or
improvements — not just understanding.

**Step 1 — explain first.** Run the full Explain flow. You must understand
the architecture before critiquing it.

**Step 2 — spawn the critic panel.** Spawn 3–4 read-only critics **in one
message**, each with the explanation, the relevant file paths, and
[`references/critique-rubric.md`](./references/critique-rubric.md), following
[`references/critic-prompt.md`](./references/critic-prompt.md). Diversity is
the mechanism: when the host offers more than one model, put each critic on a
different one; always give each critic a distinct emphasis from the rubric
(abstraction fit and boundaries; data model and types; evolution readiness
and consistency; complexity versus value) so no two critics read with the
same eyes. "An empty critique is a valid outcome."

**Step 3 — lead judgment.** You are a pragmatic lead, not an aggregator.
Sort every finding into exactly one bucket, each with the raising critic and
a one-line rationale:

- **Act on** — architectural problems worth fixing now.
- **Consider** — real concerns with unclear cost/benefit.
- **Noted** — valid observations, low priority.
- **Dismissed** — wrong, missing context, or style preference. Publish this
  bucket too; it is how the user overrides you.

Present the explanation first and the critique verdict below it — someone who
only wants to understand the system should not wade through critique.

✅ Spawn each parallel wave in a single message; explorers and critics are
always read-only.
❌ Do not critique before explaining.
❌ Do not ask clarifying questions before exploring — state the
interpretation and go.

</what-to-do>

<supporting-info>

## Output format (Explain)

Adapt to the question; not every section is needed for every question.

- **Overview.** 1–2 paragraphs: what it is, what it does, why it exists.
- **Key concepts.** The types, services, or abstractions needed to follow the
  rest. Brief, not exhaustive.
- **How it works.** The core: what triggers it, the flow step by step, where
  data goes, the decision points. Prose, not pseudocode; reference files and
  functions, no large code dumps. A mermaid or ASCII diagram only when it
  clarifies a multi-component flow.
- **Where things live.** A brief file map — just what someone needs to start
  working here.
- **Gotchas.** Non-obvious behavior, historical context, sharp edges. Skip
  when empty.

## Critic finding format

Severity `structural` (wrong abstraction boundary, broken data model,
coupling that blocks future work) | `concern` (harder to work with, not
fundamentally broken) | `observation` (a tradeoff that may not age well).
Each finding names the components, the concrete code evidence — never a bare
"this is too coupled" — and the practical impact.

## Boundaries with sibling skills

- `/context` builds the project context stack; `/how` answers one question.
- `/research` reads external official sources; `/how` reads this codebase.
- `/improve-codebase-architecture` hunts refactoring opportunities repo-wide;
  `/how`'s Critique mode judges one explained subsystem.
- `/diagnose` owns bugs and regressions.

</supporting-info>
