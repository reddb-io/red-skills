---
name: review-adrs
description: Review the `.red/adr/` set for contradictions, missing supersession links, staleness (paths/commands that moved), and numbering collisions, then reconcile each finding with the maintainer through a one-question-at-a-time interview (like `/start`) — reaching agreement before any write — and let each agreement drive the fix: renumbering, supersession notes, the thematic INDEX, and propagation into the LLM Wiki and Memory graph. Use when asked to "review the ADRs", "are any ADRs conflicting / out of date / superseded", after adding or reversing an ADR, or to group a large ADR set and keep wiki/memory claims derived from decisions in sync.
---

# Review ADRs (decision-record coherence + propagation)

ADRs accumulate (30–40+ per repo) and **derive**: one reverses another, a path it
cites moves, the wiki and Memory graph hold claims sourced from a decision that
later changed. This is the "doctor of decisions" — sibling to `/doctor` (adoption)
and `memory:doctor` (graph). Detection is read-only; **every fix is reached through
an interview** — one question per turn, `/start`-style — and the agreement *is* the
approval that drives the write. The skill never resolves a finding on its own and
never batch-applies a wall of changes.

<what-to-do>

**First detect read-only (Pass 1). Then run the Reconcile interview (Pass 2): walk the findings as a decision tree, ask ONE question per turn with a recommended resolution, wait for the reply, and apply the agreed write as the consequence of each agreement. Grouping (Pass 3) and propagation (Pass 4) are further branches of that same interview. No write without a prior agreement.**

### Hard rules

- ❌ Do not auto-resolve a finding, edit an ADR body, renumber, write the INDEX, supersede a Memory node, or re-ingest a wiki page **before that specific finding has been agreed in the interview**. Detection is read-only.
- ❌ Do not stack questions. **One `Q##` per turn.** Wait for the reply, re-evaluate the tree, then ask the next. Do not preempt the next question, and do not summarise the user's answers back at them.
- ❌ Do not batch-emit a flat approval list and walk away. The interview replaces the list — each decision is reached, then applied, then the next is raised.
- ❌ Do not delete or hard-edit Memory nodes — supersession only (reversible hide-not-delete), and only after that node's finding is agreed.
- ✅ Compose existing surfaces: `/wiki lint` for wiki claims, Memory supersession/contradiction reads for graph claims. Do not reimplement them.
- ✅ Honour ADR conventions in `start/ADR-FORMAT.md` (Status frontmatter, "superseded by ADR-NNNN", Related links).
- ✅ Apply each agreed write **inline, the moment it crystallises** (the discipline `/start` uses for `.red/CONTEXT.md`), then return to the loop — do not defer to a final phase.

### Pass 1 — Lint (detect, read-only)

Read every `.red/adr/*.md` (and `.red/CONTEXT-MAP.md` / contexts if present). Lint **against the committed tree** (`origin/HEAD`), not a dirty local working copy, so a stale local file is never mistaken for a real finding. Report:

- **Contradictions** — two ADRs whose decisions oppose on the same topic (e.g. "memory lives in `src/apps`" vs "memory moves to `red-memory`"). Flag pairs that should cross-reference but don't.
- **Missing supersession** — a later ADR reverses/supersedes an earlier one, but the earlier still reads `Status: accepted` with no "superseded by ADR-NNNN" / Related note.
- **Stale references** — an ADR cites a path / file / command that no longer exists (grep the body for paths, check existence; e.g. an ADR naming `src/domains/` after the tree became `src/apps/`).
- **Numbering** — duplicate or gap-colliding ADR numbers (two files claiming the same NNNN, e.g. when parallel branches both grab the next number).

This finding list **is the decision tree** the interview walks. Present it once, briefly, ordered by impact — then enter Pass 2.

### Pass 2 — Reconcile (the interview — `/start`-style, the core of this skill)

Walk the Pass-1 findings as a decision tree. **The loop:**

1. **Pick the next unresolved finding**, highest-impact first: numbering collisions (they break references) → contradictions → missing supersession → stale references.
2. **Ask ONE question** in the format below — branches for the finite resolution space, plus a recommended branch with a one-sentence reason.
3. **Wait** for the reply. Do not stack, do not preempt.
4. **Re-evaluate** when the answer cascades (e.g. renumbering an ADR also changes the INDEX entry and every cross-ref to it) — fold the cascade into the tree before the next question.
5. **Apply the agreed write inline** as the consequence (the agreement is the approval), then continue.
6. **Stop** when the user says stop, or when every finding is resolved.

**Question format template (identical discipline to `/start`):**

> **Q##:** [the decision to reconcile]
> **Branches:**
>  (a) [resolution A — e.g. "renumber the locally-authored ADR to the next free number, fix its inbound refs"]
>  (b) [resolution B — e.g. "renumber the other one"]
>  (c) [defer — leave the finding open, file a tracking issue]
> **Recommend:** (a), because [one-sentence reason].
> *(answer, redirect, or push back — I'll wait)*

Number questions `Q01`, `Q02`, … zero-padded to 2 digits, session-scoped (reset each invocation, never on a redirect). Prefer enumerated branches whenever the resolution space is finite; `(c) defer` is almost always a legitimate branch — a finding the maintainer wants to think about becomes a tracked issue, not a forced edit.

### Pass 3 — Group → INDEX (one agreement within the interview)

When the lint findings are reconciled (or the user wants the map first, to reason about them), raise a question to (re)generate **`.red/adr/INDEX.md`** — the decision map (the ADR analogue of `CONTEXT-MAP.md`): ADRs clustered by theme (AFK lifecycle · memory architecture · bundle/fetch/version · branch-lock · MCP/transport · licensing · repo structure · …), each entry showing theme, status, and supersession edges, reflecting the numbering/supersession just agreed. May reuse Memory graph-community clustering when graph mode is available. Writing/refreshing the index is itself one interview agreement — propose the clustering, get the nod, then write.

### Pass 4 — Propagate to Wiki + Memory (further interview branches, gated)

A changed/superseded ADR leaves derived claims dangling. For each ADR touched in Pass 2/3, raise it as its own question:

- **Wiki** — `/wiki lint` (contradictions / orphans / stale claims); find pages whose `REFERENCES` point at the changed ADR. Ask whether to re-ingest that ADR.
- **Memory** — ADRs are first-class graph nodes (engineering semantic graph). Find nodes whose provenance cites the changed ADR. Ask whether to `memory_supersede` the obsolete claims (reversible hide-not-delete).

One question per target, one agreement per write. Never silently propagate.

### Output

Not a walk-away report — a **running receipt**: each `Q##`, the agreement reached, and the write it drove (renumber / supersession note / INDEX / propagation), in order. Close with a short summary of what was reconciled, what was **deferred** (with the tracking issue if one was filed), and the single highest-impact finding still open.

</what-to-do>

<supporting-info>

### Why this is an interview, not a report

ADR reconciliation decisions are exactly the kind `/start` exists for: hard to reverse (renumbering breaks inbound refs; supersession hides graph claims), surprising without context, and the product of a real trade-off (which of two colliding ADRs renumbers? does the older one get a "partially superseded" note or a full one?). A flat approval list forces all of these at once and invites a rubber-stamp. Walking them one at a time — recommend, wait, re-evaluate — is how shared agreement is actually reached, and it lets one answer reshape the rest of the tree before the next question is asked.

### Why each finding kind exists (worked examples)

- **Contradiction / missing supersession:** ADR 0034 placed memory under `src/apps`; ADR 0041 moves it out to the `red-memory` repo — 0034 should carry a "partially superseded by 0041" note. The interview asks: full or partial supersession, and worded how?
- **Stale reference:** an ADR whose body says `src/domains/{dev,memory}` after the tree became `src/apps/` is out of date even though the *decision* still stands — the interview asks whether to fix the prose (yes) without touching the decision.
- **Numbering collision:** two PRs each grabbed "next = 0039" (one merged as `plugin-entrypoints-share-one-source`; a second authored locally had to renumber to 0041). The interview asks which file renumbers and confirms the inbound-ref fixups before applying.

### Composition map

| Pass | Reuses |
|---|---|
| 1 Lint | filesystem reads against `origin/HEAD` + `start/ADR-FORMAT.md` conventions; Memory contradiction reads when graph mode is on |
| 2 Reconcile | `/start` interview discipline (one `Q##` per turn, branches + recommend, inline side-effects) |
| 3 Group | Memory graph communities (optional) for clustering |
| 4 Propagate | `/wiki lint` + `/wiki ingest`; `memory_supersede` / Memory provenance reads |

### Boundaries

- The skill **reaches agreement, then applies** — it never silently rewrites a decision, the wiki, or the graph, and never resolves a finding without the maintainer's answer to its question.
- Pairs with `/doctor` (adoption/process) and `memory:doctor` (graph health) — three doctors over different axes; this one owns **the decision record** and is the one that resolves through dialogue.

</supporting-info>
